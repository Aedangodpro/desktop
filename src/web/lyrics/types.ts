import type {
  LyricsCandidate,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";

/** Track identity every lyrics source is asked about. */
export interface LyricsHint {
  title: string;
  artist: string;
  durationMs?: number;
}

/**
 * One lyrics source in the browser build.
 *
 * Sources run as a race (`streamLyrics.ts`), not one after another. The best
 * answer is picked by timing depth first, then quality (`ranking.ts`).
 *
 * - `tier: "synced"` (the default) sources may return syllable, word, line or
 *   plain lyrics and are all asked at once.
 * - `tier: "plain"` sources only have unsynced text and are asked only when no
 *   synced source found anything, which keeps the fallback requests off the
 *   common path.
 *
 * Adding a provider is one file with a `fetchLyrics` function plus an entry in
 * `lyricsProviders`; nothing in the player, the cache or the UI changes.
 */
export interface LyricsProvider {
  /** Name reported on the candidate and in the provider switcher. */
  readonly id: string;
  /** Lower is preferred when two candidates are otherwise equal. */
  readonly priority: number;
  /** "plain" sources are skipped while a timed answer exists. */
  readonly tier?: "synced" | "plain";
  /**
   * The richest timing this source can return. The race uses it to stop as
   * soon as no outstanding provider could beat the current best, and to avoid
   * aborting a provider that might still return syllables. Defaults to
   * `"syllable_level"` (assume it might outrank anything).
   */
  readonly maxSyncLevel?: LyricsSyncLevel;
  /** Per-request budget; defaults to 9 s. */
  readonly timeoutMs?: number;
  fetchLyrics: (
    hint: LyricsHint,
    signal?: AbortSignal,
  ) => Promise<LyricsCandidate | null>;
}
