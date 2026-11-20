import type { LyricsCandidate } from "@/shared/contracts/lyrics";

/** Track identity every lyrics source is asked about. */
export interface LyricsHint {
  title: string;
  artist: string;
  durationMs?: number;
}

/**
 * One lyrics source in the browser build.
 *
 * Sources are asked in ascending `priority` order. A source that returns
 * synced lyrics wins outright; plain text is only remembered while the
 * remaining sources get a chance at a synced match. See `resolveLyrics.ts`.
 */
export interface LyricsProvider {
  /** Name reported on the candidate and in the provider switcher. */
  readonly id: string;
  /** Lower runs first. */
  readonly priority: number;
  fetchLyrics: (
    hint: LyricsHint,
    signal?: AbortSignal,
  ) => Promise<LyricsCandidate | null>;
}
