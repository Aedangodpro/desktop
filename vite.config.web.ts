import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };
import { contentSecurityPolicyPlugin } from "./vite.csp.ts";
import {
  API_PROXY_PREFIX,
  createApiProxy,
} from "./src/web/server/apiProxy";
import { createMediaRelay } from "./src/web/server/mediaRelay";
import { setDevSigningSecret } from "./electron/crypto";

/**
 * Browser build of the Liner renderer.
 *
 * Deliberate differences from `vite.config.ts`, and why:
 * - no `vite-plugin-electron`: a browser has no main process to bundle.
 * - the API is reached through a same-origin path (`/__liner`) instead of
 *   `https://api.tryliner.fun`. The production API sends no CORS headers, so a
 *   browser cannot call it cross-origin, and every request must carry an HMAC
 *   signature that only the Electron main process can produce. The dev server
 *   proxies *and signs* that path; a hosted deployment must do the same
 *   server-side (see docs/WEB_PORT.md).
 * - `import.meta.env.VITE_API_URL` is pinned so the shared `resolveApiBaseUrl`
 *   resolver picks the proxy path in every build, including production.
 */
const SHELL_HTML = "index.web.html";
const OUT_DIR = "dist-web";

const devEnv = loadEnv("web", process.cwd(), ["LINER_"]);

const apiTarget =
  process.env.LINER_WEB_API_TARGET?.trim().replace(/\/+$/, "") ||
  devEnv.LINER_WEB_API_TARGET?.trim().replace(/\/+$/, "") ||
  "https://api.tryliner.fun";

// Local API instances accept a shared secret instead of the packaged Wasm key.
// The value stays in this Node process; it is never sent to the browser.
const devSigningSecret =
  process.env.LINER_DEV_SIGNING_SECRET || devEnv.LINER_DEV_SIGNING_SECRET;
if (devSigningSecret) setDevSigningSecret(devSigningSecret);

/**
 * The browser cannot sign API requests: the signer lives behind Electron IPC
 * and the key sits inside the main-process Wasm. This proxy performs that
 * signing server-side, which is the same trust boundary the desktop uses, and
 * keeps the key out of the page.
 *
 * It also fixes the two things a plain `http-proxy` entry cannot: cookie scope
 * (`/v1/...` upstream vs `/__liner/v1/...` in the browser) and an edge block
 * being misreported as invalid credentials.
 */
function apiProxyPlugin(): Plugin {
  const handle = createApiProxy({
    target: apiTarget,
    log: (line) => console.log(line),
  });
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => {
    void handle(req, res)
      .then((handled) => {
        if (!handled) next();
      })
      .catch(next);
  };
  return {
    name: "liner-api-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/**
 * YouTube and its media hosts send no CORS headers (and answer the Innertube
 * preflight with 403), so a page cannot call them at all. Electron fixes this in
 * the main process; here the dev/preview server is the equivalent boundary.
 *
 * `/__media?url=…` relays stream bytes with range support, `/__yt/<host>/…`
 * relays Innertube JSON. Only hosts the desktop CORS list already trusts are
 * reachable, and nothing is cached in between.
 */
function mediaRelayPlugin(): Plugin {
  const handle = createMediaRelay({ log: (line) => console.log(line) });
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => {
    void handle(req, res)
      .then((handled) => {
        if (!handled) next();
      })
      .catch(next);
  };
  return {
    name: "liner-media-relay",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/**
 * The browser shell lives in `index.web.html` so the Electron shell
 * (`index.html`) stays untouched. This plugin makes that file the default
 * document without exposing the extra filename:
 * - dev/preview: `/` and `/index.html` are rewritten to the web shell;
 * - build: the shell is emitted as `dist-web/index.html`, so any static host
 *   serves it at the root with no rewrite rules.
 *
 * No SPA history fallback is needed: the app uses HashRouter, so every route
 * is served by this single document.
 */
function webShellEntry(): Plugin {
  const rewriteRoot = (url: string | undefined): string | undefined => {
    if (!url) return url;
    const [pathname, query] = url.split("?");
    if (pathname !== "/" && pathname !== "/index.html") return url;
    return `/${SHELL_HTML}${query ? `?${query}` : ""}`;
  };

  return {
    name: "liner-web-shell-entry",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        req.url = rewriteRoot(req.url);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        req.url = rewriteRoot(req.url);
        next();
      });
    },
    writeBundle(options) {
      const dir = options.dir
        ? path.resolve(options.dir)
        : path.resolve(import.meta.dirname, OUT_DIR);
      const shellPath = path.join(dir, SHELL_HTML);
      if (!fs.existsSync(shellPath)) return;
      fs.copyFileSync(shellPath, path.join(dir, "index.html"));
      fs.rmSync(shellPath);
    },
  };
}

export default defineConfig({
  // GitHub Pages serves project sites from /<repo>/, so the asset base has to
  // follow the deploy path instead of assuming the domain root.
  base: process.env.VITE_BASE_PATH ?? "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    "import.meta.env.VITE_API_URL": JSON.stringify(
      process.env.VITE_API_URL || API_PROXY_PREFIX,
    ),
  },
  plugins: [
    react(),
    tailwindcss(),
    contentSecurityPolicyPlugin(),
    webShellEntry(),
    mediaRelayPlugin(),
    apiProxyPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  optimizeDeps: {
    // pre-bundle the heavy stores in one pass instead of mid-session, which used
    // to trigger a dependency re-optimisation and a page reload on first play or
    // first visit to settings
    include: [
      "react",
      "react-dom",
      "react-router-dom",
      "framer-motion",
      "zustand",
      "next-themes",
      "youtubei.js/web",
      "@braccato/parsers",
      "@mingcute/react",
      "@solar-icons/react",
    ],
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    warmup: {
      // transform the boot graph while the browser is still connecting
      clientFiles: [
        "./src/main.web.tsx",
        "./src/app/App.tsx",
        "./src/app/routes.tsx",
        "./src/features/player/index.ts",
        "./src/features/lyrics/index.ts",
        "./src/features/library/index.ts",
        "./src/features/settings/index.ts",
      ],
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    chunkSizeWarningLimit: 2048,
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, SHELL_HTML),
    },
  },
});
