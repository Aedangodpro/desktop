import { IS_WEB_TARGET } from "@/shared/config/runtimeTarget";
import { INNERTUBE_PROXY_PREFIX, MEDIA_PROXY_PREFIX } from "./proxyPaths";

/**
 * Rewrites hosts that refuse CORS onto the web build's own origin.
 *
 * On the desktop these requests go straight out: Electron adds the CORS headers
 * in the main process. In a browser they must pass through the relay in
 * `src/web/server/mediaRelay.ts`, or the request never leaves the page.
 */

function pageOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

export function mediaProxyUrl(url: string): string {
  if (!IS_WEB_TARGET || !url.startsWith("http")) return url;
  const prefix = `${pageOrigin()}${MEDIA_PROXY_PREFIX}`;
  if (url.startsWith(prefix)) return url;
  return `${prefix}?url=${encodeURIComponent(url)}`;
}

export function innertubeProxyUrl(url: string): string {
  if (!IS_WEB_TARGET) return url;
  try {
    const parsed = new URL(url);
    return `${pageOrigin()}${INNERTUBE_PROXY_PREFIX}/${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
