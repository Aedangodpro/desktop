export const DEFAULT_PRIMARY_API = "https://api.tryliner.fun";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A same-origin path such as `/__liner`.
 *
 * The browser build cannot call the API cross-origin (the production API sends
 * no CORS headers), so it talks to a reverse proxy on its own origin. Such a
 * path cannot downgrade transport security the way an `http://` remote URL can,
 * because it is served by the page's own secure origin.
 */
export function isSameOriginPath(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

export function isSecureBaseUrl(url: string): boolean {
  if (isSameOriginPath(url)) return true;
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" ||
      (protocol === "http:" && LOOPBACK_HOSTS.has(hostname))
    );
  } catch {
    return false;
  }
}

export function resolveApiBaseUrl(envUrl: string | undefined): string {
  const trimmed = envUrl?.trim();

  if (trimmed && isSameOriginPath(trimmed)) {
    // Keep "/" intact; strip trailing slashes from longer paths so callers can
    // always append `${base}/v1/...`.
    return trimmed.replace(/\/+$/, "") || "/";
  }

  const clean = trimmed?.replace(/\/+$/, "");
  return clean && isSecureBaseUrl(clean) ? clean : DEFAULT_PRIMARY_API;
}

const baseUrl = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL as string | undefined,
);

export function getApiBaseUrl(): string {
  return baseUrl;
}
