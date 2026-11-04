import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { signRequest as signWithWasm } from "../../../electron/crypto";

/**
 * Same-origin API proxy for the browser build.
 *
 * The desktop renderer signs every API request through Electron IPC
 * (`window.linerElectron.signRequest` -> the Wasm signer in the main process)
 * and Electron rewrites CORS on the way back. A browser has neither, so the
 * web build talks to its own origin and this server-side proxy supplies both
 * halves of that contract:
 *
 * - it signs `method path body` with the same canonical HMAC the desktop uses,
 * - it strips browser-supplied signature headers so a page can never forge one,
 * - it normalises cookies (`Domain` removed, `Path=/`) because the upstream
 *   path (`/v1/...`) is not the path the browser sees (`/__liner/v1/...`).
 *
 * The signing key never reaches the browser: only this Node process loads it.
 */

export const API_PROXY_PREFIX = "/__liner";

export interface ApiProxySignInput {
  method: string;
  path: string;
  body?: string | null;
}

export interface ApiProxySignature {
  signature: string;
  timestamp: number;
  nonce: string;
}

export type ApiProxySigner = (input: ApiProxySignInput) => ApiProxySignature;

export interface ApiProxyOptions {
  /** Upstream origin, e.g. `https://api.tryliner.fun`. */
  target: string;
  prefix?: string;
  /** Defaults to the app's own Wasm signer (or the dev secret, if set). */
  sign?: ApiProxySigner;
  log?: (message: string) => void;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

/** Never forwarded from the browser, always replaced by a server signature. */
const SIGNATURE_HEADERS = new Set([
  "x-liner-signature",
  "x-liner-timestamp",
  "x-liner-nonce",
]);

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

/**
 * The API answers the desktop client's Electron user agent and refuses browser
 * agents with a bare `403 Forbidden`, so a browser-originated request must be
 * presented as the desktop client. Signature checks come after this gate.
 */
export const DESKTOP_API_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Liner/0.2.12 Chrome/138.0.0.0 Electron/44.9.3 Safari/537.36";

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Cookies are issued for `/v1/...` but requested at `/__liner/v1/...`.
 * Without the rewrite the browser stores them at a path that never matches and
 * the session silently fails to restore after a reload.
 */
export function rewriteSetCookie(cookie: string): string {
  const withoutDomain = cookie
    .replace(/;\s*domain=[^;]*/gi, "")
    .replace(/;\s*path=[^;]*/gi, "; Path=/");
  return /;\s*path=/i.test(withoutDomain)
    ? withoutDomain
    : `${withoutDomain}; Path=/`;
}

function requestHeaders(
  req: IncomingMessage,
  target: string,
  signed: ApiProxySignature,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    // Origin/Referer describe the browser page, not this server call, and the
    // upstream treats them as a cross-origin attempt.
    if (HOP_BY_HOP.has(lower)) continue;
    if (SIGNATURE_HEADERS.has(lower)) continue;
    if (lower === "origin" || lower === "referer") continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers["host"] = new URL(target).host;
  headers["user-agent"] = DESKTOP_API_USER_AGENT;
  headers["x-liner-signature"] = signed.signature;
  headers["x-liner-timestamp"] = String(signed.timestamp);
  headers["x-liner-nonce"] = signed.nonce;
  return headers;
}

function responseHeaders(
  upstream: Response,
  cookies: string[],
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    // fetch already decoded the body; the original framing headers are stale
    if (lower === "content-encoding" || lower === "content-length") return;
    if (lower === "transfer-encoding" || lower === "connection") return;
    if (lower === "set-cookie") return;
    headers[lower] = value;
  });
  if (cookies.length) headers["set-cookie"] = cookies.map(rewriteSetCookie);
  return headers;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
  });
  res.end(text);
}

export type ApiProxyHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

export function createApiProxy(options: ApiProxyOptions): ApiProxyHandler {
  const prefix = options.prefix ?? API_PROXY_PREFIX;
  const sign = options.sign ?? signWithWasm;
  const log = options.log ?? (() => {});
  const target = options.target.replace(/\/+$/, "");

  return async function handle(req, res) {
    const url = req.url ?? "/";
    if (url !== prefix && !url.startsWith(`${prefix}/`)) return false;

    const method = (req.method ?? "GET").toUpperCase();
    const pathWithQuery = url.slice(prefix.length) || "/";
    const path = pathWithQuery.split("?")[0] || "/";
    const startedAt = Date.now();

    // widen the type: Buffer.concat returns an ArrayBufferLike-backed buffer
    let body: Buffer = Buffer.alloc(0);
    if (!BODYLESS_METHODS.has(method)) {
      try {
        body = await readRequestBody(req);
      } catch (err) {
        log(`[api-proxy] ${method} ${path} body read failed: ${String(err)}`);
        sendJson(res, 400, {
          code: "API_PROXY_BODY_UNREADABLE",
          message: "The request body could not be read.",
        });
        return true;
      }
    }

    const bodyText = body.length ? body.toString("utf8") : "";

    let signed: ApiProxySignature;
    try {
      signed = sign({ method, path, body: bodyText });
    } catch (err) {
      log(`[api-proxy] ${method} ${path} signing failed: ${String(err)}`);
      sendJson(res, 500, {
        code: "API_PROXY_SIGNING_FAILED",
        message: "The API request could not be signed.",
      });
      return true;
    }

    // A Blob keeps the bytes intact (including non-UTF-8 uploads) and satisfies
    // the fetch body type without copying through an ArrayBuffer cast.
    const payload = body.length ? new Blob([new Uint8Array(body)]) : undefined;

    let upstream: Response;
    try {
      upstream = await fetch(`${target}${pathWithQuery}`, {
        method,
        headers: requestHeaders(req, target, signed),
        ...(payload ? { body: payload } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      log(
        `[api-proxy] ${method} ${path} upstream unreachable after ${Date.now() - startedAt}ms: ${String(err)}`,
      );
      sendJson(res, 502, {
        code: "API_PROXY_UNREACHABLE",
        message: "The API could not be reached.",
      });
      return true;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const cookies =
      typeof upstream.headers.getSetCookie === "function"
        ? upstream.headers.getSetCookie()
        : [];
    const headers = responseHeaders(upstream, cookies);

    // SSE (lyrics) must not be buffered; stream it as it arrives.
    if (contentType.includes("text/event-stream") && upstream.body) {
      log(
        `[api-proxy] ${method} ${path} -> ${upstream.status} stream ${Date.now() - startedAt}ms`,
      );
      res.writeHead(upstream.status, headers);
      Readable.fromWeb(
        upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      ).pipe(res);
      return true;
    }

    const text = method === "HEAD" ? "" : await upstream.text();
    const elapsed = Date.now() - startedAt;

    // Statuses pass through untouched: the API answers a refused request with a
    // bare `403 Forbidden`, and rewriting that to a gateway error hides the one
    // signal that says what actually happened.
    log(
      `[api-proxy] ${method} ${path} -> ${upstream.status} ${elapsed}ms${text.length ? ` (${text.length}b)` : ""}`,
    );
    res.writeHead(upstream.status, {
      ...headers,
      "content-length": String(Buffer.byteLength(text)),
    });
    res.end(text);
    return true;
  };
}

/** Kept for the config's log line: the public origin this proxy talks to. */
export function upstreamOriginOf(target: string): string {
  return new URL(target).origin;
}
