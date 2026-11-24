import { describe, expect, it } from "vitest";
import { findActiveWordIndex, mergeSyllablesIntoWords } from "./wordGroups";

describe("mergeSyllablesIntoWords", () => {
  it("joins syllable segments into the word they spell", () => {
    const grouped = mergeSyllablesIntoWords(
      [
        { text: "morn", timeMs: 1000, endMs: 1220 },
        { text: "ing ", timeMs: 1220, endMs: 1500 },
        { text: "light ", timeMs: 1500, endMs: 1800 },
      ],
      "morning light",
    );

    expect(grouped).toEqual([
      { text: "morning ", timeMs: 1000, endMs: 1500 },
      { text: "light ", timeMs: 1500, endMs: 1800 },
    ]);
  });

  it("keeps genuinely separate words apart", () => {
    const grouped = mergeSyllablesIntoWords(
      [
        { text: "Look ", timeMs: 0, endMs: 300 },
        { text: "at ", timeMs: 300, endMs: 600 },
        { text: "the ", timeMs: 600, endMs: 900 },
        { text: "stars", timeMs: 900, endMs: 1400 },
      ],
      "Look at the stars",
    );

    expect(grouped.map((word) => word.text)).toEqual([
      "Look ",
      "at ",
      "the ",
      "stars",
    ]);
  });

  it("attaches whitespace-only segments to the preceding word", () => {
    const grouped = mergeSyllablesIntoWords(
      [
        { text: "morn", timeMs: 0, endMs: 200 },
        { text: "ing", timeMs: 200, endMs: 400 },
        { text: " ", timeMs: 400, endMs: 400 },
        { text: "light", timeMs: 500, endMs: 900 },
      ],
      "morning light",
    );

    expect(grouped).toEqual([
      { text: "morning ", timeMs: 0, endMs: 400 },
      { text: "light", timeMs: 500, endMs: 900 },
    ]);
  });

  it("falls back to whitespace when the line text does not line up", () => {
    const grouped = mergeSyllablesIntoWords(
      [
        { text: "Hold", timeMs: 0, endMs: 200 },
        { text: "on", timeMs: 200, endMs: 400 },
      ],
      "something else",
    );
    // no separating space in either segment, so they are one word
    expect(grouped).toHaveLength(1);
    expect(grouped[0].text).toBe("Holdon");
  });

  it("handles empty input", () => {
    expect(mergeSyllablesIntoWords([], "line")).toEqual([]);
  });
});

describe("findActiveWordIndex", () => {
  const words = [
    { text: "a", timeMs: 0, endMs: 100 },
    { text: "b", timeMs: 100, endMs: 200 },
    { text: "c", timeMs: 200, endMs: 300 },
  ];

  it("finds the last word that has started", () => {
    expect(findActiveWordIndex(words, 0)).toBe(0);
    expect(findActiveWordIndex(words, 150)).toBe(1);
    expect(findActiveWordIndex(words, 999)).toBe(2);
  });

  it("returns -1 before the first word", () => {
    expect(
      findActiveWordIndex([{ text: "a", timeMs: 500, endMs: 900 }], 100),
    ).toBe(-1);
    expect(findActiveWordIndex([], 100)).toBe(-1);
  });
});
