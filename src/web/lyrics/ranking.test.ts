import { describe, expect, it } from "vitest";
import type {
  LyricsCandidate,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";
import {
  buildQuality,
  compareCandidates,
  isDecisiveCandidate,
  preferCandidate,
  syncTier,
} from "./ranking";

function candidate(
  provider: string,
  syncLevel: LyricsSyncLevel,
  total = 80,
): LyricsCandidate {
  return {
    provider,
    contentKind: "line_synced",
    syncLevel,
    lyrics: { format: "lrc", content: "[00:01.00]line" },
    quality: {
      total,
      match: 70,
      content: 70,
      sync: 70,
      source: 70,
      reasons: [],
    },
  };
}

describe("buildQuality", () => {
  it("derives the timing score from the sync level", () => {
    const plain = buildQuality({
      syncLevel: "plain",
      match: 60,
      content: 60,
      source: 40,
    });
    const syllable = buildQuality({
      syncLevel: "syllable_level",
      match: 60,
      content: 60,
      source: 40,
    });

    expect(plain.sync).toBe(0);
    expect(syllable.sync).toBe(97);
    expect(syllable.total).toBeGreaterThan(plain.total);
    expect(plain.reasons).toEqual([]);
  });

  it("weighs recording match above everything else", () => {
    const matched = buildQuality({
      syncLevel: "line_level",
      match: 100,
      content: 50,
      source: 40,
    });
    const wrongTrack = buildQuality({
      syncLevel: "line_level",
      match: 20,
      content: 100,
      source: 100,
    });
    expect(matched.total).toBeGreaterThan(wrongTrack.total);
  });

  it("keeps an explicit sync override", () => {
    const quality = buildQuality({
      syncLevel: "word_level",
      match: 80,
      content: 80,
      source: 80,
      sync: 40,
      reasons: ["unverified timing"],
    });
    expect(quality.sync).toBe(40);
    expect(quality.reasons).toEqual(["unverified timing"]);
  });
});

describe("compareCandidates", () => {
  it("prefers syllables over words over lines over plain", () => {
    const order = [
      candidate("plain", "plain"),
      candidate("line", "line_level"),
      candidate("word", "word_level"),
      candidate("syllable", "syllable_level"),
    ].sort(compareCandidates);

    expect(order.map((item) => item.provider)).toEqual([
      "syllable",
      "word",
      "line",
      "plain",
    ]);
  });

  it("keeps a top-priority provider ahead of richer timing", () => {
    const liner = {
      ...candidate("Liner", "line_level", 70),
      topPriority: true,
    };
    const lrcmux = candidate("LRCMUX", "word_level", 95);

    expect(preferCandidate(liner, lrcmux)).toBe(true);
    expect(preferCandidate(lrcmux, liner)).toBe(false);
  });

  it("uses quality within the same sync level", () => {
    const good = candidate("Atlas", "syllable_level", 95);
    const weak = candidate("Polaris", "syllable_level", 70);
    expect(preferCandidate(good, weak)).toBe(true);
    expect(preferCandidate(weak, good)).toBe(false);
  });

  it("is a stable, total order for equal candidates", () => {
    const a = candidate("B", "line_level", 70);
    const b = candidate("A", "line_level", 70);
    expect(compareCandidates(a, b)).toBeGreaterThan(0);
    expect(compareCandidates(a, a)).toBe(0);
  });
});

describe("isDecisiveCandidate", () => {
  it("accepts word and syllable answers with a trustworthy match", () => {
    expect(isDecisiveCandidate(candidate("a", "word_level", 80))).toBe(true);
    expect(isDecisiveCandidate(candidate("a", "syllable_level", 95))).toBe(
      true,
    );
  });

  it("keeps waiting on lines and on weak word matches", () => {
    expect(isDecisiveCandidate(candidate("a", "line_level", 99))).toBe(false);
    expect(isDecisiveCandidate(candidate("a", "word_level", 40))).toBe(false);
    expect(isDecisiveCandidate(candidate("a", "plain", 99))).toBe(false);
  });
});

describe("syncTier", () => {
  it("names each fallback tier", () => {
    expect(syncTier("syllable_level")).toBe("syllable");
    expect(syncTier("word_level")).toBe("word");
    expect(syncTier("line_level")).toBe("line");
    expect(syncTier("plain")).toBe("plain");
  });
});
