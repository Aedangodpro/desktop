/**
 * Build target discriminator.
 *
 * The desktop app is bundled with Vite's default mode; the browser build runs
 * with `--mode web` (see `vite.config.web.ts`). Behavior that must differ
 * between targets reads this flag instead of probing `window.linerElectron`:
 * the preload bridge is intentionally absent in the browser build, so probing
 * it would conflate "no bridge" with "running on the web".
 */
export const IS_WEB_TARGET = import.meta.env.MODE === "web";

/** True when the renderer is running inside the Electron shell. */
export const IS_DESKTOP_TARGET = !IS_WEB_TARGET;
