import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { needsOpenCors } from "../../../electron/cors";
import { INNERTUBE_PROXY_PREFIX, MEDIA_PROXY_PREFIX } from "../proxyPaths";

/**
 * Same-origin relay for media and Innertube traffic in the browser build.
 *
 * Electron makes these hosts usable by rewriting CORS in the main process
 * (`electron/cors.ts`). A page cannot do that, and both of these refuse to talk
 * to a browser origin directly:
 *
 * - `music.youtube.com/youtubei/v1/*` answers an OPTIONS preflight with `403`
 *   and no `access-control-*` headers, so every Innertube call, search and
 *   player lookup included, fails as a CORS error.
 * - `*.googlevideo.com` sends no CORS headers either, so neither the reachability
 *   probe nor `<audio crossorigin="anonymous">` (needed for the Web Audio
 *   effects graph) can load a stream.
 *
 * The relay keeps the page same-origin:
 *
 *   GET  /__media?url=<encoded https url>   -> the media host
 *   POST /__yt/<host>/<path>?<query>        -> https://<host>/<path>
 *
 * It is a byte pipe, not a cache or a shim: ranges, statuses and content types
 * pass through, and only hosts on the desktop CORS allowlist are reachable.
 */

export interface MediaRelayOptions {
  log?: (message: string) => void;
}

export type MediaRelayHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

const INNERTUBE_HOSTS = new Set([
  "www.youtube.com",
  "music.youtube.com",
  "youtubei.googleapis.com",
]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The page's own identity is meaningless upstream and trips CORS/host checks. */
const PAGE_HEADERS = new Set([
  "origin",
  "referer",
  "cookie",
  "host",
  "content-length",
  "accept-encoding",
]);

/**
 * googlevideo answers a range-less request, an open-ended `bytes=0-`, and a
 * range that runs past the end of the file with `403`; only a bounded range
 * inside the file answers `206`. Media elements open with exactly `bytes=0-`,
 * so the relay asks for one byte first to learn the total from `content-range`
 * and then requests a range that fits.
 */
export const UPSTREAM_CHUNK_BYTES = 256 * 1024;
const ANY_RANGE = /^bytes=(\d+)-(\d*)$/;
const CONTENT_RANGE_TOTAL = /^bytes \d+-\d+\/(\d+)$/i;

async function contentTotal(
  target: URL,
  offset: number,
): Promise<number | null> {
  try {
    const probe = await fetch(target, {
      headers: {
        range: `bytes=${offset}-${offset}`,
        "accept-encoding": "identity",
      },
    });
    await probe.body?.cancel().catch(() => undefined);
    const total = CONTENT_RANGE_TOTAL.exec(
      probe.headers.get("content-range") ?? "",
    )?.[1];
    return total ? Number(total) : null;
  } catch {
    return null;
  }
}

async function upstreamRange(
  target: URL,
  requested: string | undefined,
): Promise<string> {
  const parsed = requested ? ANY_RANGE.exec(requested.trim()) : null;
  const start = parsed ? Number(parsed[1]) : 0;
  const total = await contentTotal(target, start);
  // A range that runs to the final byte is treated as a whole-file download and
  // refused, so keep one byte in reserve; the player reads the real total from
  // `content-range` and asks for the next window itself.
  const cap = total
    ? Math.min(total - 2, start + UPSTREAM_CHUNK_BYTES - 1)
    : start + UPSTREAM_CHUNK_BYTES - 1;
  return `bytes=${start}-${Math.max(start, cap)}`;
}

const LOGGED_MEDIA_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
  "cache-control",
];

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

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pipeBody(res: ServerResponse, body: ReadableStream<Uint8Array>): void {
  const stream = Readable.fromWeb(
    body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
}

async function handleMedia(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  log: (message: string) => void,
): Promise<boolean> {
  const target = url.searchParams.get("url");
  if (!target) {
    sendJson(res, 400, {
      code: "MEDIA_PROXY_NO_URL",
      message: "A media url is required.",
    });
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(res, 400, {
      code: "MEDIA_PROXY_BAD_URL",
      message: "The media url is not valid.",
    });
    return true;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    sendJson(res, 400, {
      code: "MEDIA_PROXY_BAD_PROTOCOL",
      message: "Only http(s) media urls are relayed.",
    });
    return true;
  }

  if (!needsOpenCors(parsed.toString(), true)) {
    log(`[media-proxy] refused host ${parsed.hostname}`);
    sendJson(res, 403, {
      code: "MEDIA_PROXY_HOST_REFUSED",
      message: "That host is not relayed.",
    });
    return true;
  }

  const method = req.method === "HEAD" ? "HEAD" : "GET";
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  // explicit start/end lets the chunked downloader ask for exact windows, since
  // a query param cannot carry a Range header through a media element
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  headers.range =
    start !== null && end !== null
      ? `bytes=${start}-${end}`
      : await upstreamRange(
          parsed,
          typeof req.headers.range === "string" ? req.headers.range : undefined,
        );
  if (typeof req.headers["if-range"] === "string")
    headers["if-range"] = req.headers["if-range"];

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(parsed, { method, headers, redirect: "follow" });
  } catch (error) {
    log(
      `[media-proxy] ${method} ${parsed.hostname} unreachable: ${String(error)}`,
    );
    sendJson(res, 502, {
      code: "MEDIA_PROXY_UNREACHABLE",
      message: "The media host could not be reached.",
    });
    return true;
  }

  const out: Record<string, string> = { ...corsHeaders() };
  for (const name of LOGGED_MEDIA_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }

  log(
    `[media-proxy] ${method} ${parsed.hostname}${parsed.pathname} range=${headers.range} -> ${upstream.status} ${Date.now() - startedAt}ms`,
  );

  res.writeHead(upstream.status, out);
  if (method === "HEAD" || !upstream.body) {
    res.end();
    return true;
  }
  pipeBody(res, upstream.body);
  return true;
}

async function handleInnertube(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  log: (message: string) => void,
): Promise<boolean> {
  const rest = url.pathname.slice(INNERTUBE_PROXY_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const host = slash === -1 ? "" : rest.slice(0, slash);
  if (!host || !INNERTUBE_HOSTS.has(host)) {
    sendJson(res, 403, {
      code: "INNERTUBE_PROXY_HOST_REFUSED",
      message: "That host is not relayed.",
    });
    return true;
  }

  const method = (req.method ?? "GET").toUpperCase();
  const path = `/${rest.slice(slash + 1)}${url.search}`;
  const bodyless = method === "GET" || method === "HEAD";
  const body = bodyless ? Buffer.alloc(0) : await readRequestBody(req);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(lower) || PAGE_HEADERS.has(lower)) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.host = host;
  // Innertube rejects some clients unless the request looks like it came from
  // the site that owns the endpoint.
  headers.origin = `https://${host}`;
  headers.referer = `https://${host}/`;
  if (body.length) headers["content-length"] = String(body.length);

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(`https://${host}${path}`, {
      method,
      headers,
      ...(body.length ? { body: new Uint8Array(body) } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    log(`[innertube-proxy] ${method} ${host}${path} failed: ${String(error)}`);
    sendJson(res, 502, {
      code: "INNERTUBE_PROXY_UNREACHABLE",
      message: "YouTube could not be reached.",
    });
    return true;
  }

  const out: Record<string, string> = { ...corsHeaders() };
  const contentType = upstream.headers.get("content-type");
  if (contentType) out["content-type"] = contentType;
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) out["cache-control"] = cacheControl;

  log(
    `[innertube-proxy] ${method} ${host}${path.split("?")[0]} -> ${upstream.status} ${Date.now() - startedAt}ms`,
  );

  res.writeHead(upstream.status, out);
  if (method === "HEAD" || !upstream.body) {
    res.end();
    return true;
  }
  pipeBody(res, upstream.body);
  return true;
}

export function createMediaRelay(
  options: MediaRelayOptions = {},
): MediaRelayHandler {
  const log = options.log ?? (() => {});

  return async function handle(req, res) {
    const raw = req.url ?? "/";
    const url = new URL(raw, "http://relay.local");
    if (url.pathname === MEDIA_PROXY_PREFIX)
      return handleMedia(req, res, url, log);
    if (
      url.pathname === INNERTUBE_PROXY_PREFIX ||
      url.pathname.startsWith(`${INNERTUBE_PROXY_PREFIX}/`)
    )
      return handleInnertube(req, res, url, log);
    return false;
  };
}
