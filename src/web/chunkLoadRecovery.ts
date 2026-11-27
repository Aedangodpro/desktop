/**
 * A deploy replaces every content-hashed asset, so a tab that was opened before
 * it still points at chunk urls that now return 404. The break only shows up
 * later, when one of those chunks is imported on demand — a route, or the PO
 * token minter the next play needs — and it surfaces as a failed track instead
 * of as a stale app.
 *
 * One reload picks up the deployment's own bundle. The session, queue and
 * resume position are persisted, so the user comes back to the same place. The
 * timestamp stops a reload loop when the deployment itself is what is broken.
 */
const RELOAD_AT_KEY = "liner_chunk_reload_at_v1";
const RELOAD_COOLDOWN_MS = 30_000;

export function installChunkLoadRecovery(
  reload: () => void = () => window.location.reload(),
): () => void {
  if (typeof window === "undefined") return () => {};

  const onPreloadError = (event: Event) => {
    event.preventDefault();
    const now = Date.now();
    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(window.sessionStorage.getItem(RELOAD_AT_KEY) ?? 0);
    } catch {
      // storage can be blocked; then the reload is simply not throttled
    }
    if (
      Number.isFinite(lastReloadAt) &&
      now - lastReloadAt < RELOAD_COOLDOWN_MS
    )
      return;
    try {
      window.sessionStorage.setItem(RELOAD_AT_KEY, String(now));
    } catch {
      // same as above
    }
    reload();
  };

  window.addEventListener("vite:preloadError", onPreloadError);
  return () => window.removeEventListener("vite:preloadError", onPreloadError);
}
