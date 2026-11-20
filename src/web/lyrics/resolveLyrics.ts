import type {
  LyricsCandidate,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";
import { lrcmuxProvider } from "./lrcmuxLyrics";
import { lrclibProvider } from "./lrclibLyrics";
import type { LyricsHint, LyricsProvider } from "./types";

const SYNC_DEPTH: Record<LyricsSyncLevel, number> = {
  plain: 0,
  line_level: 1,
  word_level: 2,
  syllable_level: 3,
};

/** Every source the browser build can reach, best first. */
export const lyricsProviders: LyricsProvider[] = [lrcmuxProvider, lrclibProvider];

export function isWebLyricsProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  const name = provider.toLowerCase().trim();
  return lyricsProviders.some((item) => item.id.toLowerCase() === name);
}

export interface LyricsResolution {
  candidate: LyricsCandidate;
  /** providers that were actually asked, in order */
  attempted: string[];
}

/**
 * Resolves lyrics for a track.
 *
 * LRCMUX is asked first because it can return per-word timings. A synced
 * answer is final; a plain answer is held while the remaining sources are
 * tried, so a later line-synced result still wins. If nobody has synced
 * lyrics the plain text is returned, and if nobody has lyrics at all the
 * result is `null`.
 */
export async function resolveLyrics(
  hint: LyricsHint,
  signal?: AbortSignal,
): Promise<LyricsResolution | null> {
  if (!hint.title?.trim() || !hint.artist?.trim()) return null;

  const ordered = [...lyricsProviders].sort(
    (a, b) => a.priority - b.priority,
  );
  const attempted: string[] = [];
  let plain: LyricsCandidate | null = null;

  for (const provider of ordered) {
    attempted.push(provider.id);
    let candidate: LyricsCandidate | null = null;
    try {
      candidate = await provider.fetchLyrics(hint, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      candidate = null;
    }
    if (!candidate?.lyrics.content) continue;
    if (SYNC_DEPTH[candidate.syncLevel] > 0) {
      return { candidate, attempted };
    }
    if (
      !plain ||
      SYNC_DEPTH[candidate.syncLevel] > SYNC_DEPTH[plain.syncLevel]
    ) {
      plain = candidate;
    }
  }

  return plain ? { candidate: plain, attempted } : null;
}
