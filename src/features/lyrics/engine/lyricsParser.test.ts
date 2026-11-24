import { describe, expect, it } from "vitest";
import { parseRawLyrics } from "./lyricsParser";
import { mergeSyllablesIntoWords } from "./wordGroups";

interface Token {
  c: string;
  o: number;
}

function richsync(ts: number, te: number, tokens: Token[]): string {
  return JSON.stringify([{ ts, te, l: tokens }]);
}

describe("parseRawLyrics richsync offsets", () => {
  it("reads `o` as an offset from the line start (Atlas / Musixmatch)", () => {
    const parsed = parseRawLyrics(
      richsync(28.975, 32.958, [
        { c: "The ", o: 0 },
        { c: "morning ", o: 0.325 },
        { c: "light ", o: 0.781 },
      ]),
      "richsync",
    );

    const line = parsed.syncedLines[0];
    expect(line.timeMs).toBe(28_975);
    expect(line.durationMs).toBe(3_983);
    expect(line.text).toBe("The morning light ");
    expect(
      line.words?.map((word) => [word.text, word.timeMs, word.endMs]),
    ).toEqual([
      ["The ", 28_975, 29_300],
      ["morning ", 29_300, 29_756],
      ["light ", 29_756, 32_958],
    ]);
  });

  it("still accepts absolute timestamps in `o` (LRCMUX)", () => {
    const parsed = parseRawLyrics(
      richsync(33.58, 35.7, [
        { c: "Look ", o: 33.58 },
        { c: "at ", o: 33.87 },
        { c: "the ", o: 34.16 },
        { c: "stars", o: 34.45 },
      ]),
      "richsync",
    );

    expect(
      parsed.syncedLines[0].words?.map((word) => [word.text, word.timeMs]),
    ).toEqual([
      ["Look ", 33_580],
      ["at ", 33_870],
      ["the ", 34_160],
      ["stars", 34_450],
    ]);
  });

  it("keeps offsets relative on a line that starts before one second", () => {
    // 0.781 s into a line at 0.5 s is 1281 ms, not 781 ms
    const parsed = parseRawLyrics(
      richsync(0.5, 2, [
        { c: "Oh ", o: 0 },
        { c: "yeah", o: 0.781 },
      ]),
      "richsync",
    );

    expect(
      parsed.syncedLines[0].words?.map((word) => [word.text, word.timeMs]),
    ).toEqual([
      ["Oh ", 500],
      ["yeah", 1_281],
    ]);
  });

  it("merges whitespace-only tokens into the previous word", () => {
    const parsed = parseRawLyrics(
      richsync(1, 3, [
        { c: "Hold", o: 0 },
        { c: " ", o: 0.2 },
        { c: "on ", o: 0.4 },
      ]),
      "richsync",
    );

    expect(
      parsed.syncedLines[0].words?.map((word) => [word.text, word.timeMs]),
    ).toEqual([
      ["Hold ", 1_000],
      ["on ", 1_400],
    ]);
  });

  it("keeps syllable segments timed and groups them back into words", () => {
    const parsed = parseRawLyrics(
      richsync(1, 3, [
        { c: "morn", o: 0 },
        { c: "ing ", o: 0.45 },
        { c: "light ", o: 1.2 },
      ]),
      "richsync",
    );

    const line = parsed.syncedLines[0];
    expect(line.words).toHaveLength(3);

    expect(
      mergeSyllablesIntoWords(line.words ?? [], line.text).map((word) => [
        word.text,
        word.timeMs,
        word.endMs,
      ]),
    ).toEqual([
      ["morning ", 1_000, 2_200],
      ["light ", 2_200, 3_000],
    ]);
  });
});
