import type { LyricsCandidate } from "@/shared/contracts/lyrics";
import { lrcmuxProvider } from "./lrcmuxLyrics";
import { lrclibProvider } from "./lrclibLyrics";
import { lyricsOvhProvider } from "./lyricsOvh";
import { preferCandidate } from "./ranking";
import { streamLyricsEvents } from "./streamLyrics";
import type { LyricsHint, LyricsProvider } from "./types";

/**
 * Every source the browser build can reach. They are asked as a race; this
 * array only fixes the order requests start in (best first) and the provider
 * switcher's display order.
 */
export const lyricsProviders: LyricsProvider[] = [
  lrcmuxProvider,
  lrclibProvider,
  lyricsOvhProvider,
];

export function isWebLyricsProvider(
  provider: string | null | undefined,
): boolean {
  if (!provider) return false;
  const name = provider.toLowerCase().trim();
  return lyricsProviders.some((item) => item.id.toLowerCase() === name);
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

  for await (const event of streamLyricsEvents(hint, lyricsProviders, signal, {
    onAttempt: (provider) => attempted.push(provider),
  })) {
    if (event.type !== "provider" || event.status !== "found") continue;
    if (!best || preferCandidate(event.candidate, best)) {
      best = event.candidate;
    }
  }

  return best ? { candidate: best, attempted } : null;
}
