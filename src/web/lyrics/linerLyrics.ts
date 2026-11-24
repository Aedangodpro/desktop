import type { LyricsCandidate } from "@/shared/contracts/lyrics";
import { getAuthSession } from "@/shared/api/auth-session";
import type { LyricsHint, LyricsProvider } from "./types";

/**
 * The Liner API's lyrics search, used as the primary source in the browser
 * build.
 *
 * The API is only reachable through the same-origin `/__liner` proxy and its
 * search route lives under `/v1/me`, so this needs a signed-in session. Without
 * one the provider reports nothing and the public race is the whole answer.
 *
 * `api` is imported dynamically because `shared/api/api.ts` imports the web
 * lyrics providers for its web streaming branch; a static import would make
 * that a module cycle.
 */
export async function fetchLinerLyrics(
  hint: LyricsHint,
  signal?: AbortSignal,
): Promise<LyricsCandidate | null> {
  if (!hint.title?.trim() || !hint.artist?.trim()) return null;
  if (!getAuthSession()?.accessToken) return null;

  const { api } = await import("@/shared/api");
  const result = await api.searchLyrics(hint, signal);
  const candidate = result?.candidate;
  if (!candidate?.lyrics?.content?.trim()) return null;

  return {
    ...candidate,
    provider: candidate.provider || "Liner",
    // The server already matched the recording and ranked its own providers.
    // This flag is what makes the engine and the cache prefer this answer over
    // a richer-timed public one (e.g. LRCMUX word-level) instead of replacing
    // it on sync depth alone.
    topPriority: true,
  };
}

export const linerLyricsProvider: LyricsProvider = {
  id: "Liner",
  priority: 0,
  topPriority: true,
  // the Liner API can return syllable-level timing, the richest tier
  maxSyncLevel: "syllable_level",
  // the proxy is a short hop; do not hold the fallback race for long
  timeoutMs: 4_000,
  fetchLyrics: fetchLinerLyrics,
};
