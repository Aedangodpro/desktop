/**
 * Browser entry point.
 *
 * The desktop renderer is reused as-is. Every call into the Electron main
 * process already goes through optional `window.linerElectron` lookups, so the
 * browser simply runs without that object and takes the web code paths that
 * ship with the app (localStorage sessions, DOM fullscreen, service-worker
 * covers, "unavailable" saved-device storage).
 *
 * `installWebRuntime()` must run before the root renders, so the import is
 * dynamic: static ESM imports are hoisted and would evaluate `main.tsx` first.
 */
import { installWebRuntime } from "@/web/installWebRuntime";

installWebRuntime();

void import("@/main");
