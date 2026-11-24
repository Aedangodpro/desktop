import type { LyricsCandidate } from "@/shared/contracts/lyrics";
import { getAuthSession } from "@/shared/api/auth-session";
import { linerLyricsProvider } from "./linerLyrics";
import { lrcmuxProvider } from "./lrcmuxLyrics";
import { lrclibProvider } from "./lrclibLyrics";
import { lyricsOvhProvider } from "./lyricsOvh";
import { preferCandidate } from "./ranking";
import { streamLyricsEvents } from "./streamLyrics";
import type { LyricsHint, LyricsProvider } from "./types";

/**
 * The public sources the browser build can reach without an account. They are
 * asked as a race; this array only fixes the order requests start in and the
 * provider switcher's display order.
 */
export const lyricsProviders: LyricsProvider[] = [
  lrcmuxProvider,
  lrclibProvider,
  lyricsOvhProvider,
];

/**
 * Providers for the current session. The Liner API is first when the user is
 * signed in, and its answers are marked `topPriority`; the public sources stay
 * in the race as the fallback for signed-out users and for tracks the API does
 * not have.
 */
export function webLyricsProviders(signedIn: boolean): LyricsProvider[] {
  return signedIn ? [linerLyricsProvider, ...lyricsProviders] : lyricsProviders;
}

/** Provider names that can only come from the Liner API's own engine. */
const LINER_API_PROVIDERS = new Set([
  "liner",
  "cadence",
  "polaris",
  "polaris mono",
  "liner atlas",
  "genius",
]);

export function isWebLyricsProvider(
  provider: string | null | undefined,
): boolean {
  if (!provider) return false;
  const name = provider.toLowerCase().trim().replace(/[-_]/g, " ");
  return (
    lyricsProviders.some((item) => item.id.toLowerCase() === name) ||
    LINER_API_PROVIDERS.has(name)
  );
}

export interface LyricsResolution {
  candidate: LyricsCandidate;
  /** providers that were actually asked, in start order */
  attempted: string[];
}

/**
 * Resolves lyrics for a track, keeping only the winner of the race.
 *
 * Playback uses the streaming form instead (`api.streamLyrics`), so results are
 * painted as each provider settles. This entry point exists for callers that
 * just want the best answer, and shares the same race, ranking and abort
 * behaviour.
 */
export async function resolveLyrics(
  hint: LyricsHint,
  signal?: AbortSignal,
): Promise<LyricsResolution | null> {
  if (!hint.title?.trim() || !hint.artist?.trim()) return null;

  const attempted: string[] = [];
  let best: LyricsCandidate | null = null;

  for await (const event of streamLyricsEvents(
    hint,
    webLyricsProviders(Boolean(getAuthSession()?.accessToken)),
    signal,
    { onAttempt: (provider) => attempted.push(provider) },
  )) {
    if (event.type !== "provider" || event.status !== "found") continue;
    if (!best || preferCandidate(event.candidate, best)) {
      best = event.candidate;
    }
  }

  return best ? { candidate: best, attempted } : null;
}
