import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLrcmuxCooldown } from "./lrcmuxLyrics";
import { isWebLyricsProvider, resolveLyrics } from "./resolveLyrics";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hostOf(input: unknown): string {
  return new URL(String(input)).host;
}

const lrcmuxWord = {
  track: { title: "Yellow", artist: "Coldplay", duration: 266 },
  meta: { source: { id: "deezer" }, level: "word" },
  lines: [
    {
      text: "Look at the stars",
      start: 33_580,
      end: 35_700,
      words: [
        { text: "Look ", start: 33_580, end: 33_870 },
        { text: "at ", start: 33_870, end: 34_160 },
        { text: "the ", start: 34_160, end: 34_450 },
        { text: "stars", start: 34_450, end: 35_400 },
      ],
    },
  ],
};

const lrcmuxPlain = {
  track: { title: "Yellow", artist: "Coldplay" },
  meta: { source: { id: "ytmusic" }, level: "none" },
  lines: [{ text: "Look at the stars" }],
};

const lrclibSynced = {
  trackName: "Yellow",
  artistName: "Coldplay",
  duration: 266,
  syncedLyrics: "[00:33.58]Look at the stars",
  plainLyrics: "Look at the stars",
};

const ovhPlain = { lyrics: "Look at the stars\nLook how they shine" };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetLrcmuxCooldown();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveLyrics", () => {
  it("returns LRCMUX word-level lyrics and starts LRCLIB alongside it", async () => {
    fetchMock.mockResolvedValue(json(lrcmuxWord));

    const resolved = await resolveLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });

    expect(resolved?.candidate.provider).toBe("LRCMUX");
    expect(resolved?.candidate.syncLevel).toBe("word_level");
    // both synced sources race; the decisive word answer stops the race
    expect(resolved?.attempted).toEqual(["LRCMUX", "LRCLIB"]);
    // LRCMUX /get, LRCLIB /get, LRCLIB /search (its payload has no lyrics)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(hostOf(fetchMock.mock.calls[0]![0])).toBe("api.lrcmux.dev");
    expect(hostOf(fetchMock.mock.calls[1]![0])).toBe("lrclib.net");
  });

  it("falls back to LRCLIB when LRCMUX has nothing", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ status: 404, detail: "no lyrics found" }, 404),
      )
      .mockResolvedValueOnce(json(lrclibSynced));

    const resolved = await resolveLyrics({
      title: "Yellow",
      artist: "Coldplay",
      durationMs: 266_000,
    });

    expect(resolved?.candidate.provider).toBe("LRCLIB");
    expect(resolved?.candidate.syncLevel).toBe("line_level");
    expect(resolved?.attempted).toEqual(["LRCMUX", "LRCLIB"]);
  });

  it("prefers LRCLIB line sync over LRCMUX plain text", async () => {
    fetchMock
      .mockResolvedValueOnce(json(lrcmuxPlain))
      .mockResolvedValueOnce(json(lrclibSynced));

    const resolved = await resolveLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });

    expect(resolved?.candidate.provider).toBe("LRCLIB");
    expect(resolved?.candidate.syncLevel).toBe("line_level");
  });

  it("keeps LRCMUX plain text and only then asks Lyrics.ovh", async () => {
    fetchMock
      .mockResolvedValueOnce(json(lrcmuxPlain))
      .mockResolvedValueOnce(json([], 200))
      .mockResolvedValueOnce(json([], 200))
      .mockResolvedValueOnce(json(ovhPlain));

    const resolved = await resolveLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });

    expect(resolved?.candidate.provider).toBe("LRCMUX");
    expect(resolved?.candidate.syncLevel).toBe("plain");
    expect(resolved?.candidate.lyrics.content).toBe("Look at the stars");
    expect(resolved?.attempted).toEqual(["LRCMUX", "LRCLIB"]);
  });

  it("uses Lyrics.ovh when no synced source has lyrics", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ status: 404 }, 404))
      .mockResolvedValueOnce(json([], 200))
      .mockResolvedValueOnce(json([], 200))
      .mockResolvedValueOnce(json(ovhPlain));

    const resolved = await resolveLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });

    expect(resolved?.candidate.provider).toBe("Lyrics.ovh");
    expect(resolved?.candidate.syncLevel).toBe("plain");
    expect(resolved?.candidate.lyrics.content).toBe(
      "Look at the stars\nLook how they shine",
    );
    expect(resolved?.attempted).toEqual(["LRCMUX", "LRCLIB", "Lyrics.ovh"]);
  });

  it("returns null when no provider has lyrics", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ status: 404 }, 404))
      .mockResolvedValueOnce(json([], 200))
      .mockResolvedValueOnce(json([], 200))
      .mockResolvedValueOnce(json({ error: "No lyrics found" }, 404));

    await expect(
      resolveLyrics({ title: "Unknown", artist: "Nobody" }),
    ).resolves.toBeNull();
  });

  it("does not call any provider without a title and artist", async () => {
    await expect(
      resolveLyrics({ title: " ", artist: "Coldplay" }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a provider that throws", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(json(lrclibSynced));

    const resolved = await resolveLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });
    expect(resolved?.candidate.provider).toBe("LRCLIB");
  });
});

describe("isWebLyricsProvider", () => {
  it("recognizes the reachable sources", () => {
    expect(isWebLyricsProvider("LRCMUX")).toBe(true);
    expect(isWebLyricsProvider("lrclib")).toBe(true);
    expect(isWebLyricsProvider("Lyrics.ovh")).toBe(true);
    // the Liner API's own providers are reachable in the browser build too
    expect(isWebLyricsProvider("Liner")).toBe(true);
    expect(isWebLyricsProvider("Cadence")).toBe(true);
    expect(isWebLyricsProvider("Liner Atlas")).toBe(true);
    expect(isWebLyricsProvider("desktop-only-source")).toBe(false);
    expect(isWebLyricsProvider(null)).toBe(false);
  });
});
