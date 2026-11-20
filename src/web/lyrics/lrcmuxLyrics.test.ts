import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRawLyrics } from "@/features/lyrics";
import {
  fetchLrcmuxLyrics,
  resetLrcmuxCooldown,
} from "./lrcmuxLyrics";

const fetchMock = vi.fn();

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const wordPayload = {
  track: {
    title: "Yellow",
    artist: "Coldplay",
    album: "Parachutes",
    duration: 266,
    isrc: "GBAYE0000267",
    cover: {},
  },
  meta: { source: { id: "kugou", name: "KuGou" }, level: "word" },
  lines: [
    {
      text: "Look at the stars",
      start: 33580,
      end: 35700,
      words: [
        { text: "Look ", start: 33580, end: 33870 },
        { text: "at ", start: 33870, end: 34160 },
        { text: "the ", start: 34160, end: 34450 },
        { text: "stars", start: 34450, end: 35400 },
      ],
    },
    {
      text: "Look how they shine for you",
      start: 36300,
      end: 40209,
      words: [
        { text: "Look ", start: 36300, end: 36600 },
        { text: "how ", start: 36600, end: 36910 },
        { text: "they ", start: 36910, end: 37270 },
        { text: "shine ", start: 37270, end: 37920 },
        { text: "for ", start: 37920, end: 39120 },
        { text: "you", start: 39120, end: 40209 },
      ],
    },
  ],
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetLrcmuxCooldown();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLrcmuxLyrics", () => {
  it("requests JSON with the cleaned title, artist and duration", async () => {
    fetchMock.mockResolvedValueOnce(json(wordPayload));

    await fetchLrcmuxLyrics({
      title: "Yellow (Official Video)",
      artist: "Coldplay",
      durationMs: 266_000,
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://api.lrcmux.dev/get");
    expect(url.searchParams.get("title")).toBe("Yellow");
    expect(url.searchParams.get("artist")).toBe("Coldplay");
    expect(url.searchParams.get("duration")).toBe("266");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("normalizes word-level lyrics into the app's synced format", async () => {
    fetchMock.mockResolvedValueOnce(json(wordPayload));

    const candidate = await fetchLrcmuxLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });
    expect(candidate?.provider).toBe("LRCMUX");
    expect(candidate?.syncLevel).toBe("word_level");
    expect(candidate?.contentKind).toBe("word_synced");
    expect(candidate?.lyrics.format).toBe("richsync");
    expect(candidate?.matchedTrack).toEqual({
      title: "Yellow",
      artists: ["Coldplay"],
      durationMs: 266_000,
    });

    const parsed = parseRawLyrics(
      candidate!.lyrics.content,
      candidate!.lyrics.format,
      266_000,
    );
    expect(parsed.syncedLines).toHaveLength(2);
    expect(parsed.syncedLines[0].text).toBe("Look at the stars");
    expect(parsed.syncedLines[0].timeMs).toBe(33_580);
    expect(parsed.syncedLines[0].durationMs).toBe(1820);
    expect(
      parsed.syncedLines[0].words?.map((word) => [
        word.text,
        word.timeMs,
        word.endMs,
      ]),
    ).toEqual([
      ["Look ", 33580, 33870],
      ["at ", 33870, 34160],
      ["the ", 34160, 34450],
      ["stars", 34450, 35400],
    ]);
    // the last word keeps its real end instead of running into the next line
    expect(parsed.syncedLines[1].words?.at(-1)).toMatchObject({
      text: "you",
      timeMs: 39120,
      endMs: 40209,
    });
  });

  it("keeps line-synced answers as LRC", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        track: { title: "Yellow", artist: "Coldplay", duration: 266 },
        meta: { source: { id: "ytmusic", name: "YouTube Music" }, level: "line" },
        lines: [
          { text: "Look at the stars", start: 33580, end: 35700 },
          { text: "Look how they shine for you", start: 36300, end: 40209 },
        ],
      }),
    );

    const candidate = await fetchLrcmuxLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });
    expect(candidate?.syncLevel).toBe("line_level");
    expect(candidate?.contentKind).toBe("line_synced");
    expect(candidate?.lyrics.format).toBe("lrc");
    expect(candidate?.lyrics.content).toBe(
      "[00:33.58]Look at the stars\n[00:36.30]Look how they shine for you",
    );
    const parsed = parseRawLyrics(candidate!.lyrics.content, "lrc", 266_000);
    const timed = parsed.syncedLines.filter((line) => !line.isInstrumental);
    expect(timed.map((line) => [line.text, line.timeMs])).toEqual([
      ["Look at the stars", 33_580],
      ["Look how they shine for you", 36_300],
    ]);
  });

  it("returns plain lyrics when the source has no timings", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        track: { title: "Yellow", artist: "Coldplay" },
        meta: { source: { id: "ytmusic", name: "YouTube Music" }, level: "none" },
        lines: [
          { text: "Look at the stars" },
          { text: "Look how they shine for you" },
        ],
      }),
    );

    const candidate = await fetchLrcmuxLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });
    expect(candidate?.syncLevel).toBe("plain");
    expect(candidate?.lyrics).toEqual({
      format: "plain",
      content: "Look at the stars\nLook how they shine for you",
    });
  });

  it("passes through multi-word vocabularies and trims the last word", async () => {
    fetchMock.mockResolvedValueOnce(json(wordPayload));
    const candidate = await fetchLrcmuxLyrics({
      title: "Yellow",
      artist: "Coldplay",
    });
    const lines = JSON.parse(candidate!.lyrics.content) as {
      l: { c: string; o: number }[];
    }[];
    expect(lines[0]!.l.at(-1)).toEqual({ c: "stars", o: 34.45 });
  });

  it("rejects timed lyrics from a different recording", async () => {
    // the API answers a 213s request with the 347s "Cake Mix"
    fetchMock.mockResolvedValueOnce(
      json({
        ...wordPayload,
        track: { ...wordPayload.track, duration: 347 },
      }),
    );

    await expect(
      fetchLrcmuxLyrics({
        title: "Never Gonna Give You Up",
        artist: "Rick Astley",
        durationMs: 213_000,
      }),
    ).resolves.toBeNull();
  });

  it("accepts a result whose length is close to the track", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        ...wordPayload,
        track: { ...wordPayload.track, duration: 271 },
      }),
    );

    const candidate = await fetchLrcmuxLyrics({
      title: "Yellow",
      artist: "Coldplay",
      durationMs: 266_000,
    });
    expect(candidate?.syncLevel).toBe("word_level");
  });

  it("treats an instrumental answer as no lyrics", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        track: { title: "Intro", artist: "Artist" },
        meta: { instrumental: true, level: "none", source: { id: "deezer" } },
        lines: [],
      }),
    );

    await expect(
      fetchLrcmuxLyrics({ title: "Intro", artist: "Artist" }),
    ).resolves.toBeNull();
  });

  it("returns null on 404 and on transport errors", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ title: "Not Found", status: 404, detail: "no lyrics found" }, 404),
      )
      .mockRejectedValueOnce(new TypeError("network down"));

    await expect(
      fetchLrcmuxLyrics({ title: "Unknown", artist: "Nobody" }),
    ).resolves.toBeNull();
    await expect(
      fetchLrcmuxLyrics({ title: "Unknown", artist: "Nobody" }),
    ).resolves.toBeNull();
  });

  it("parks itself for Retry-After after a 429", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ title: "Too Many Requests", status: 429 }, 429, {
        "retry-after": "12",
      }),
    );

    await expect(
      fetchLrcmuxLyrics({ title: "Yellow", artist: "Coldplay" }),
    ).resolves.toBeNull();
    // the cooldown short-circuits before any further request
    await expect(
      fetchLrcmuxLyrics({ title: "Yellow", artist: "Coldplay" }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips incomplete hints", async () => {
    await expect(
      fetchLrcmuxLyrics({ title: "  ", artist: "Coldplay" }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

    await expect(
      fetchLrcmuxLyrics({ title: "Yellow", artist: "Coldplay" }, controller.signal),
    ).rejects.toThrow();
  });
});
