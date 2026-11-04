/**
 * Freebuff Sites worker for the browser build.
 *
 * The SPA is static, but three same-origin endpoints cannot be: the API needs
 * request signing, Innertube refuses browser preflights, and googlevideo sends
 * no CORS and caps ranges. This worker supplies all three and falls back to the
 * static assets for everything else.
 *
 * The signer is the same wasm the desktop main process loads, imported as a
 * module: workerd compiles it at deploy time and refuses runtime compilation.
 */

import signerModule from "./signer.wasm";

const API_TARGET = "https://api.tryliner.fun";
// The API refuses browser/curl user agents with a bare 403; it expects the
// desktop client, so the relay presents Electron's identity.
const API_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Liner/0.2.12 Chrome/138.0.0.0 " +
  "Electron/44.9.3 Safari/537.36";
const API_PREFIX = "/__liner";
const MEDIA_PREFIX = "/__media";
const YT_PREFIX = "/__yt";
const UPSTREAM_CHUNK_BYTES = 256 * 1024;

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

const SIGNATURE_HEADERS = new Set([
  "x-liner-signature",
  "x-liner-timestamp",
  "x-liner-nonce",
]);

const PAGE_HEADERS = new Set([
  "origin",
  "referer",
  "cookie",
  "host",
  "content-length",
  "accept-encoding",
]);

/**
 * Cloudflare adds these to the request the worker receives. Forwarding them to
 * another Cloudflare-fronted origin looks like a loop/spoof (the upstream sees
 * `cdn-loop` and a foreign `cf-connecting-ip`) and is answered with 403.
 * The desktop client sends none of them, so neither should this proxy.
 */
const PLATFORM_HEADERS = new Set([
  "cdn-loop",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cf-ew-via",
  "true-client-ip",
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "via",
]);

function isPlatformHeader(name) {
  return (
    PLATFORM_HEADERS.has(name) ||
    name.startsWith("cf-") ||
    name.startsWith("x-forwarded-")
  );
}

const INNERTUBE_HOSTS = new Set([
  "www.youtube.com",
  "music.youtube.com",
  "youtubei.googleapis.com",
]);

const OPEN_CORS_DOMAINS = [
  "tryliner.fun",
  "youtube.com",
  "googlevideo.com",
  "ytimg.com",
  "ggpht.com",
  "googleusercontent.com",
  "soundcloud.com",
  "sndcdn.com",
  "soundcloud.cloud",
  "spotify.com",
  "spotifycdn.com",
  "spotify.link",
  "scdn.co",
  "deezer.com",
  "dzcdn.net",
  "music.apple.com",
  "mzstatic.com",
  "genius.com",
  "r2.cloudflarestorage.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

const LOGGED_MEDIA_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
  "cache-control",
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ANY_RANGE = /^bytes=(\d+)-(\d*)$/;
const CONTENT_RANGE_TOTAL = /^bytes \d+-\d+\/(\d+)$/i;

let signerPromise = null;

async function getSigner() {
  if (!signerPromise) {
    signerPromise = (async () => {
      // A compiled module returns the Instance directly; passing bytes would.
      const instance = await WebAssembly.instantiate(signerModule, {});
      return instance.exports;
    })();
  }
  return signerPromise;
}

function passString(wasm, text) {
  const bytes = encoder.encode(text);
  const ptr = wasm.liner_alloc(bytes.length);
  if (bytes.length) {
    new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
  }
  return { ptr, len: bytes.length };
}

function readResult(wasm) {
  const ptr = wasm.liner_get_result_ptr();
  const len = wasm.liner_get_result_len();
  if (!ptr || len === 0) return "";
  return decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
}

async function signRequest(method, path, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(8));
  const nonce = Array.from(nonceBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const wasm = await getSigner();
  const methodBuf = passString(wasm, method);
  const pathBuf = passString(wasm, path);
  const bodyBuf = passString(wasm, body);
  const nonceBuf = passString(wasm, nonce);

  try {
    const code = wasm.liner_sign_request(
      methodBuf.ptr,
      methodBuf.len,
      pathBuf.ptr,
      pathBuf.len,
      bodyBuf.ptr,
      bodyBuf.len,
      BigInt(timestamp),
      nonceBuf.ptr,
      nonceBuf.len,
    );
    if (code !== 0) throw new Error(`wasm sign_request failed: ${code}`);
    return { signature: readResult(wasm), timestamp, nonce };
  } finally {
    for (const buf of [methodBuf, pathBuf, bodyBuf, nonceBuf]) {
      wasm.liner_dealloc(buf.ptr, buf.len);
    }
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
}

function needsOpenCors(value) {
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    return false;
  }
  return OPEN_CORS_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function rewriteSetCookie(cookie) {
  const withoutDomain = cookie
    .replace(/;\s*domain=[^;]*/gi, "")
    .replace(/;\s*path=[^;]*/gi, "; Path=/");
  return /;\s*path=/i.test(withoutDomain)
    ? withoutDomain
    : `${withoutDomain}; Path=/`;
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  return [];
}

function copyHeaders(source, drop, request = false) {
  const headers = new Headers();
  source.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (drop.has(lower)) return;
    if (request && isPlatformHeader(lower)) return;
    headers.set(name, value);
  });
  return headers;
}

function apiResponseHeaders(upstream) {
  const headers = copyHeaders(
    upstream.headers,
    new Set([
      "content-encoding",
      "content-length",
      "transfer-encoding",
      "connection",
      "set-cookie",
    ]),
  );
  for (const cookie of getSetCookies(upstream)) {
    headers.append("set-cookie", rewriteSetCookie(cookie));
  }
  return headers;
}

async function handleApi(request, url) {
  const method = request.method.toUpperCase();
  const pathWithQuery = url.pathname.slice(API_PREFIX.length) + url.search;
  const path = pathWithQuery.split("?")[0] || "/";
  const bodyless = method === "GET" || method === "HEAD";
  const bytes = bodyless ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
  const bodyText = bytes.length ? decoder.decode(bytes) : "";

  let signed;
  try {
    signed = await signRequest(method, path, bodyText);
  } catch (error) {
    return json(500, {
      code: "API_PROXY_SIGNING_FAILED",
      message: String(error),
    });
  }

  const headers = copyHeaders(
    request.headers,
    new Set([...HOP_BY_HOP, ...SIGNATURE_HEADERS, "origin", "referer"]),
    true,
  );
  headers.set("user-agent", API_USER_AGENT);
  headers.set("x-liner-signature", signed.signature);
  headers.set("x-liner-timestamp", String(signed.timestamp));
  headers.set("x-liner-nonce", signed.nonce);

  let upstream;
  try {
    upstream = await fetch(`${API_TARGET}${pathWithQuery}`, {
      method,
      headers,
      body: bytes.length ? bytes : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return json(502, {
      code: "API_PROXY_UNREACHABLE",
      message: String(error),
    });
  }

  const out = apiResponseHeaders(upstream);
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return new Response(method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: out,
    });
  }

  const text = method === "HEAD" ? "" : await upstream.text();
  return new Response(text, { status: upstream.status, headers: out });
}

async function contentTotal(target, offset) {
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

async function upstreamRange(target, requested) {
  const parsed = requested ? ANY_RANGE.exec(requested.trim()) : null;
  const start = parsed ? Number(parsed[1]) : 0;
  const total = await contentTotal(target, start);
  const cap = total
    ? Math.min(total - 2, start + UPSTREAM_CHUNK_BYTES - 1)
    : start + UPSTREAM_CHUNK_BYTES - 1;
  return `bytes=${start}-${Math.max(start, cap)}`;
}

async function handleMedia(request, url) {
  const target = url.searchParams.get("url");
  if (!target) {
    return json(400, {
      code: "MEDIA_PROXY_NO_URL",
      message: "A media url is required.",
    });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json(400, {
      code: "MEDIA_PROXY_BAD_URL",
      message: "The media url is not valid.",
    });
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return json(400, {
      code: "MEDIA_PROXY_BAD_PROTOCOL",
      message: "Only http(s) media urls are relayed.",
    });
  }

  if (!needsOpenCors(parsed.toString())) {
    return json(403, {
      code: "MEDIA_PROXY_HOST_REFUSED",
      message: "That host is not relayed.",
    });
  }

  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const headers = new Headers({ "accept-encoding": "identity" });
  headers.set(
    "range",
    start !== null && end !== null
      ? `bytes=${start}-${end}`
      : await upstreamRange(parsed, request.headers.get("range")),
  );
  const ifRange = request.headers.get("if-range");
  if (ifRange) headers.set("if-range", ifRange);

  let upstream;
  try {
    upstream = await fetch(parsed, { method, headers, redirect: "follow" });
  } catch (error) {
    return json(502, {
      code: "MEDIA_PROXY_UNREACHABLE",
      message: String(error),
    });
  }

  const out = new Headers(corsHeaders());
  for (const name of LOGGED_MEDIA_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }

  if (method === "HEAD" || !upstream.body) {
    return new Response(null, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function handleInnertube(request, url) {
  const rest = url.pathname.slice(YT_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const host = slash === -1 ? "" : rest.slice(0, slash);
  if (!host || !INNERTUBE_HOSTS.has(host)) {
    return json(403, {
      code: "INNERTUBE_PROXY_HOST_REFUSED",
      message: "That host is not relayed.",
    });
  }

  const method = request.method.toUpperCase();
  const path = `/${rest.slice(slash + 1)}${url.search}`;
  const bodyless = method === "GET" || method === "HEAD";
  const bytes = bodyless
    ? new Uint8Array()
    : new Uint8Array(await request.arrayBuffer());

  const headers = copyHeaders(request.headers, PAGE_HEADERS, true);
  headers.set("origin", `https://${host}`);
  headers.set("referer", `https://${host}/`);

  let upstream;
  try {
    upstream = await fetch(`https://${host}${path}`, {
      method,
      headers,
      body: bytes.length ? bytes : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return json(502, {
      code: "INNERTUBE_PROXY_UNREACHABLE",
      message: String(error),
    });
  }

  const out = new Headers(corsHeaders());
  const contentType = upstream.headers.get("content-type");
  if (contentType) out.set("content-type", contentType);
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) out.set("cache-control", cacheControl);

  if (method === "HEAD" || !upstream.body) {
    return new Response(null, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/**
 * Hashed files never change, so the browser may keep them instead of
 * revalidating on every visit. Errors are left uncached.
 */
const IMMUTABLE_ASSET = /^\/assets\//;

/**
 * Client routes (/search, /library, ...) are not files. Only a real navigation
 * gets index.html; a missing script or image keeps its 404 so a broken build
 * stays visible instead of being masked by the app shell.
 */
function isNavigation(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

async function serveAsset(request, env, url) {
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && isNavigation(request)) {
    const index = await env.ASSETS.fetch(new URL("/index.html", url.origin));
    if (index.status === 200) response = index;
  }
  if (response.status !== 200 || !IMMUTABLE_ASSET.test(url.pathname)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(response.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        return await handleApi(request, url);
      }
      if (url.pathname === MEDIA_PREFIX) {
        return await handleMedia(request, url);
      }
      if (url.pathname === YT_PREFIX || url.pathname.startsWith(`${YT_PREFIX}/`)) {
        return await handleInnertube(request, url);
      }
    } catch (error) {
      return json(500, {
        code: "SITES_WORKER_ERROR",
        message: String(error),
      });
    }

    if (env?.ASSETS) return serveAsset(request, env, url);
    return new Response("Not found", { status: 404 });
  },
};
