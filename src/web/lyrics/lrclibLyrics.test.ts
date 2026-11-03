import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanLyricsTitle, fetchLrclibLyrics } from "./lrclibLyrics";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cleanLyricsTitle", () => {
  it("drops release noise that LRCLIB does not index", () => {
    expect(cleanLyricsTitle("Never Gonna Give You Up (Official Video)")).toBe(
      "Never Gonna Give You Up",
    );
    expect(cleanLyricsTitle("Song [Official Audio]")).toBe("Song");
    expect(cleanLyricsTitle("Song (Remastered 2011)")).toBe("Song");
  });

  it("keeps a parenthetical that is part of the title", () => {
    expect(cleanLyricsTitle("Time (Clock of the Heart)")).toBe(
      "Time (Clock of the Heart)",
    );
  });
});

describe("fetchLrclibLyrics", () => {
  it("returns a line-synced candidate from an exact match", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        trackName: "Never Gonna Give You Up",
        artistName: "Rick Astley",
        duration: 213,
        syncedLyrics: "[00:01.00]hello",
        plainLyrics: "hello",
      }),
    );

    const candidate = await fetchLrclibLyrics({
      title: "Never Gonna Give You Up (Official Video)",
      artist: "Rick Astley",
      durationMs: 213_000,
    });

    expect(candidate?.provider).toBe("LRCLIB");
    expect(candidate?.lyrics.format).toBe("lrc");
    expect(candidate?.syncLevel).toBe("line_level");
    expect(candidate?.lyrics.content).toBe("[00:01.00]hello");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("track_name=");
  });

  it("falls back to search and prefers a synced result near the duration", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(
        json([
          {
            trackName: "Other",
            artistName: "Rick Astley",
            duration: 500,
            plainLyrics: "wrong",
          },
          {
            trackName: "Never Gonna Give You Up",
            artistName: "Rick Astley",
            duration: 214,
            syncedLyrics: "[00:02.00]right",
          },
        ]),
      );

    const candidate = await fetchLrclibLyrics({
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      durationMs: 213_000,
    });

    expect(candidate?.lyrics.content).toBe("[00:02.00]right");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/search?");
  });

  it("returns null when nothing matches", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json([], 200));

    await expect(
      fetchLrclibLyrics({ title: "Unknown", artist: "Nobody" }),
    ).resolves.toBeNull();
  });

  it("treats an instrumental result as no lyrics", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ instrumental: true }, 200))
      .mockResolvedValueOnce(json([], 200));

    await expect(
      fetchLrclibLyrics({ title: "Intro", artist: "Artist" }),
    ).resolves.toBeNull();
  });
});
