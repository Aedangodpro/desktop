import { useEffect } from "react";

const SERVICE_WORKER_URL = "/liner-sw.js";

/**
 * Registers the browser build's service worker: app shell + cover art, with
 * offline navigation. It is skipped in development so HMR is never served from
 * a cache, and in Electron so a stale worker cannot intercept the file shell.
 */
export function CoverSwRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const isElectron =
      window.location.protocol === "file:" ||
      typeof (window as any).linerElectron !== "undefined";

    if (isElectron) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const reg of registrations) {
          void reg.unregister();
        }
      });
      return;
    }

    if (!import.meta.env.PROD) {
      // A worker installed by an earlier production visit at this origin would
      // keep answering with cached chunks across a dev restart.
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          for (const reg of registrations) void reg.unregister();
        })
        .catch(() => {});
      return;
    }

    navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { scope: "/" })
      .catch(() => {
        // Registration failure is non-fatal: covers still load, the app just
        // does not open offline.
      });
  }, []);

  return null;
}
