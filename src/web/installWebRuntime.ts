import {
  registerInnertubeFetch,
  registerPoTokenMinter,
} from "@/shared/youtube/innertube/webBridges";
import { innertubeProxyUrl } from "./proxyUrls";
import { installChunkLoadRecovery } from "./chunkLoadRecovery";

/**
 * Browser shell bootstrap.
 *
 * Runs before the React root is created. Everything here is deliberately
 * concern-free: it never touches application state, it only adapts the document
 * to behave like an application window instead of a page.
 */

/** hosts youtube.js may reach, all of them through `/__yt` on this origin */
const RELAYED_YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "music.youtube.com",
  "youtubei.googleapis.com",
  "www.google.com",
  "jnn-pa.googleapis.com",
]);

/**
 * youtube.js is written for Node and fetches youtube.com directly, which a page
 * cannot do. Route its requests through the relay the same way the Innertube
 * client already does.
 */
function relayedYoutubeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (RELAYED_YOUTUBE_HOSTS.has(parsed.host)) {
      const proxied = innertubeProxyUrl(parsed.toString());
      if (proxied !== parsed.toString()) {
        return typeof input === "string" || input instanceof URL
          ? fetch(proxied, init)
          : fetch(new Request(proxied, input), init);
      }
    }
  } catch {
    // not a URL the relay knows: leave it alone
  }
  return fetch(input, init);
}

function installYoutubeBridges(): void {
  registerInnertubeFetch(relayedYoutubeFetch);
  // BotGuard is only needed once a track has to be resolved, and it is a large
  // dependency, so it stays out of the first paint.
  registerPoTokenMinter(async (identifier) => {
    const { mintWebPoToken } = await import("./youtube/webMinter");
    return mintWebPoToken(identifier);
  });
}

const SPLASH_ID = "boot-splash";
const SPLASH_SAFETY_TIMEOUT_MS = 12_000;

let installed = false;

function dismissBootSplash(): void {
  const splash = document.getElementById(SPLASH_ID);
  if (!splash) return;

  // `data-ready` fades the splash out in CSS; removing the node afterwards keeps
  // it out of the accessibility tree and out of hit-testing.
  document.documentElement.dataset.ready = "true";
  window.setTimeout(() => splash.setAttribute("aria-hidden", "true"), 280);
  window.setTimeout(() => splash.remove(), 900);
}

function dismissSplashOnFirstPaint(): void {
  const root = document.getElementById("root");
  if (!root) return;
  if (root.childElementCount > 0) {
    dismissBootSplash();
    return;
  }

  const observer = new MutationObserver(() => {
    if (root.childElementCount === 0) return;
    observer.disconnect();
    dismissBootSplash();
  });
  observer.observe(root, { childList: true });

  // Safety net: a failed mount must not leave the user staring at a splash.
  window.setTimeout(() => {
    observer.disconnect();
    dismissBootSplash();
  }, SPLASH_SAFETY_TIMEOUT_MS);
}

/**
 * Ask the browser to keep this origin's storage (the audio cache and the
 * service worker's shell cache) out of its eviction pool. Chrome rejects the
 * first ask on a fresh origin and grants it after engagement, so the first
 * interaction is used for a second, quieter attempt.
 */
function requestPersistentStorage(): void {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return;

  const ensure = () => {
    void navigator.storage
      .persisted()
      .then((persisted) => (persisted ? true : navigator.storage.persist()))
      .catch(() => false);
  };

  ensure();
  window.addEventListener("pointerdown", ensure, {
    once: true,
    passive: true,
  });
}

/**
 * Dropping a file onto a page makes the browser navigate to it, which unmounts
 * the whole app and loses playback state. Desktop apps never do that.
 */
function blockFileNavigation(): void {
  const carriesFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  window.addEventListener("dragover", (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
}

export function installWebRuntime(): void {
  if (installed) return;
  installed = true;

  document.documentElement.setAttribute("data-runtime", "web");
  installChunkLoadRecovery();
  requestPersistentStorage();
  blockFileNavigation();
  installYoutubeBridges();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", dismissSplashOnFirstPaint, {
      once: true,
    });
  } else {
    dismissSplashOnFirstPaint();
  }

  // Restoring from the back/forward cache must not replay the splash.
  window.addEventListener("pageshow", () => {
    document.documentElement.dataset.ready = "true";
    document.getElementById(SPLASH_ID)?.remove();
  });
}
