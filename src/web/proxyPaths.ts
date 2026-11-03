/**
 * Same-origin paths the browser build uses for hosts that refuse CORS.
 *
 * Shared by the Vite middleware (Node) and the renderer, so it must stay free
 * of Node built-ins.
 */
export const MEDIA_PROXY_PREFIX = "/__media";
export const INNERTUBE_PROXY_PREFIX = "/__yt";
