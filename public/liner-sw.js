/**
 * Liner service worker: app shell + cover art cache.
 *
 * Two caches, each with a hard cap so a long-lived install cannot grow without
 * bound:
 * - `liner-shell-v1`: the document and its hashed chunks. Navigations are
 *   network-first (a deploy is picked up immediately) and fall back to the
 *   cached shell, which is what makes the app open offline. Asset hits are
 *   moved to the end of the cache so the entry cap behaves like an LRU.
 * - `liner-covers-v2`: remote cover images, unchanged name and quota so the
 *   storage screen keeps reporting the same numbers. Insertion-order eviction
 *   (CacheStorage returns keys in insertion order), capped by entry count.
 *
 * API/media relays (`/__liner`, `/__media`, `/__yt`) are never touched: the
 * first two are POST/range traffic and every one of them is user-specific.
 */

const SW_VERSION = "v1";
const SHELL_CACHE = `liner-shell-${SW_VERSION}`;
const COVER_CACHE = "liner-covers-v2";

const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/icon.png"];
const SHELL_ENTRY_URLS = new Set(SHELL_URLS);

const MAX_SHELL_ENTRIES = 180;
const MAX_COVER_ENTRIES = 600;
// The biggest build chunk is well under this; anything larger is not an asset
// worth pinning and would push the cache over its budget.
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

const COVER_HOSTS = [
  "yt3.googleusercontent.com",
  "lh3.googleusercontent.com",
  "covers.tryliner.fun",
  "i1.sndcdn.com",
  "i2.sndcdn.com",
  "i3.sndcdn.com",
  "i4.sndcdn.com",
  "img.sndcdn.com",
  "a1.sndcdn.com",
  "i.pinimg.com",
  "images.genius.com",
  "yandex-images.clstorage.net",
];

const coverInFlight = new Map();

function isCoverRequest(url) {
  try {
    const parsed = new URL(url);
    if (
      !parsed.pathname ||
      parsed.pathname === "/" ||
      parsed.pathname === "/health"
    ) {
      return false;
    }
    return COVER_HOSTS.some(
      (host) =>
        parsed.hostname === host || parsed.hostname.endsWith("." + host),
    );
  } catch {
    return false;
  }
}

function isAssetRequest(url) {
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/src/")) {
    return true;
  }
  return /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpg|jpeg|webp|svg|gif|ico|webmanifest)$/i.test(
    url.pathname,
  );
}

function isPrivilegedPath(url) {
  return (
    url.pathname.startsWith("/__liner") ||
    url.pathname.startsWith("/__media") ||
    url.pathname.startsWith("/__yt")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One missing shell file must not fail the whole install, so each URL is
      // fetched on its own.
      await Promise.all(
        SHELL_URLS.map(async (path) => {
          try {
            const response = await fetch(path, { cache: "no-cache" });
            if (response.ok) await cache.put(path, response);
          } catch {}
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== COVER_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function trimShellCache(cache) {
  try {
    const keys = await cache.keys();
    let excess = keys.length - MAX_SHELL_ENTRIES;
    for (const request of keys) {
      if (excess <= 0) break;
      const path = new URL(request.url).pathname;
      if (SHELL_ENTRY_URLS.has(path)) continue;
      await cache.delete(request);
      excess -= 1;
    }
  } catch {}
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      // Every route is the same document (HashRouter), so one copy is enough.
      try {
        await cache.put("/index.html", response.clone());
      } catch {}
    }
    return response;
  } catch {
    return (
      (await cache.match("/index.html")) ||
      (await cache.match("/")) ||
      Response.error()
    );
  }
}

async function handleShellAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // Move the hit to the end so the entry cap evicts the least recently used
    // asset instead of whichever chunk happened to be fetched first.
    try {
      await cache.delete(request);
      await cache.put(request, cached.clone());
    } catch {}
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      const length = Number(response.headers.get("content-length") || 0);
      if (length <= MAX_ASSET_BYTES) {
        try {
          await cache.put(request, response.clone());
          await trimShellCache(cache);
        } catch {}
      }
    }
    return response;
  } catch {
    return (await cache.match("/index.html")) || Response.error();
  }
}

async function enforceCoverQuota(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_COVER_ENTRIES) {
      const toDelete = keys.slice(0, keys.length - MAX_COVER_ENTRIES);
      await Promise.all(toDelete.map((request) => cache.delete(request)));
    }
  } catch {}
}

async function fetchAndCacheCover(request, cache, cacheKey) {
  let pending = coverInFlight.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(request);
      if (response.ok && response.type !== "opaque") {
        await cache.put(cacheKey, response.clone());
        void enforceCoverQuota(cache);
      }
      return response;
    })().finally(() => coverInFlight.delete(cacheKey));
    coverInFlight.set(cacheKey, pending);
  }
  return (await pending).clone();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  if (isCoverRequest(request.url)) {
    const cacheKey = request.url;
    event.respondWith(
      caches.open(COVER_CACHE).then(async (cache) => {
        const cached = await cache.match(cacheKey, { ignoreVary: true });
        if (cached) return cached;

        try {
          return await fetchAndCacheCover(request, cache, cacheKey);
        } catch (error) {
          const stale = await cache.match(cacheKey, { ignoreVary: true });
          if (stale) return stale;
          throw error;
        }
      }),
    );
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isPrivilegedPath(url)) return;
  // Range requests are media playback; a partial response must never be cached
  // as if it were the whole file.
  if (request.headers.has("range")) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isAssetRequest(url)) {
    event.respondWith(handleShellAsset(request));
  }
});
