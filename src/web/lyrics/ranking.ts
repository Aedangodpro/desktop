import type {
  LyricsCandidate,
  LyricsQuality,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";

/**
 * How much timing a sync level actually gives us. A syllable level answer is a
 * strict superset of a word level one, which is a superset of a line level one,
 * so a provider that returns syllables always outranks one that returns words.
 */
export const SYNC_DEPTH: Record<LyricsSyncLevel, number> = {
  plain: 0,
  line_level: 1,
  word_level: 2,
  syllable_level: 3,
};

const DEFAULT_SYNC_SCORE: Record<LyricsSyncLevel, number> = {
  plain: 0,
  line_level: 82,
  word_level: 94,
  syllable_level: 97,
};

export interface QualityInput {
  syncLevel: LyricsSyncLevel;
  /** How sure we are this is the same recording (0-100). */
  match: number;
  /** How usable the text itself is (0-100). */
  content: number;
  /** How much the source is trusted (0-100). */
  source: number;
  /** Override the timing score derived from `syncLevel`. */
  sync?: number;
  reasons?: string[];
}

/**
 * The same weighted score the Liner API computes for competing providers:
 * recording match weighs most, then timing depth, then text quality, then how
 * much the source has earned our trust.
 */
export function buildQuality(input: QualityInput): LyricsQuality {
  const sync = input.sync ?? DEFAULT_SYNC_SCORE[input.syncLevel];
  const total = Math.round(
    input.match * 0.35 +
      input.content * 0.25 +
      sync * 0.25 +
      input.source * 0.15,
  );
  return {
    total,
    match: input.match,
    content: input.content,
    sync,
    source: input.source,
    reasons: input.reasons ?? [],
  };
}

/** Negative when `a` should be shown before `b`. */
export function compareCandidates(
  a: LyricsCandidate,
  b: LyricsCandidate,
): number {
  const depth = (SYNC_DEPTH[b.syncLevel] ?? 0) - (SYNC_DEPTH[a.syncLevel] ?? 0);
  if (depth !== 0) return depth;
  if (b.quality.total !== a.quality.total) {
    return b.quality.total - a.quality.total;
  }
  return a.provider.localeCompare(b.provider);
}

export function preferCandidate(
  next: LyricsCandidate,
  current: LyricsCandidate,
): boolean {
  return compareCandidates(next, current) < 0;
}

/**
 * A candidate good enough to stop waiting on the other providers: per-word (or
 * finer) timing, and not a suspiciously bad match. Line-synced answers keep the
 * race open because a word-level answer is worth a few hundred milliseconds.
 */
export function isDecisiveCandidate(candidate: LyricsCandidate): boolean {
  return (
    (SYNC_DEPTH[candidate.syncLevel] ?? 0) >= SYNC_DEPTH.word_level &&
    candidate.quality.total >= 70
  );
}

/** Human-readable name of the richest timing the lyrics actually carry. */
export function syncTier(
  level: LyricsSyncLevel,
): "syllable" | "word" | "line" | "plain" {
  switch (level) {
    case "syllable_level":
      return "syllable";
    case "word_level":
      return "word";
    case "line_level":
      return "line";
    default:
      return "plain";
  }
}
