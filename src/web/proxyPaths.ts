/**
 * Same-origin paths the browser build uses for hosts that refuse CORS.
 *
 * Shared by the Vite middleware (Node) and the renderer, so it must stay free
 * of Node built-ins.
 */
export const MEDIA_PROXY_PREFIX = "/__media";
export const INNERTUBE_PROXY_PREFIX = "/__yt";

/**
 * Hosts the `/__yt` relay forwards besides Innertube.
 *
 * SoundCloud's API and the page its client id is scraped from answer no CORS
 * headers at all, so a browser cannot read either. Its HLS media does send
 * `access-control-allow-origin: *` and is fetched without the relay.
 */
export const API_RELAY_HOSTS: ReadonlySet<string> = new Set([
  "api-v2.soundcloud.com",
  "soundcloud.com",
]);
