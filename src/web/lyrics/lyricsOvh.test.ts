import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLyricsOvh, lyricsOvhProvider } from "./lyricsOvh";

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

describe("fetchLyricsOvh", () => {
  it("requests the cleaned title and encoded artist", async () => {
    fetchMock.mockResolvedValueOnce(json({ lyrics: "Look at the stars" }));

    await fetchLyricsOvh({
      title: "Yellow (Official Video)",
      artist: "Coldplay",
      durationMs: 266_000,
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.lyrics.ovh/v1/Coldplay/Yellow",
    );
  });

  it("returns plain lyrics scored below any synced source", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ lyrics: "Look at the stars\r\n\r\n\r\nLook how they shine" }),
    );

    const candidate = await fetchLyricsOvh({
      title: "Yellow",
      artist: "Coldplay",
    });

    expect(candidate?.provider).toBe("Lyrics.ovh");
    expect(candidate?.syncLevel).toBe("plain");
    expect(candidate?.contentKind).toBe("plain");
    expect(candidate?.lyrics).toEqual({
      format: "plain",
      content: "Look at the stars\n\nLook how they shine",
    });
    expect(candidate?.quality.total).toBeLessThan(60);
    expect(lyricsOvhProvider.tier).toBe("plain");
  });

  it("returns null for a missing song, empty lyrics and bad payloads", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "No lyrics found" }, 404))
      .mockResolvedValueOnce(json({ lyrics: "   \n  " }))
      .mockResolvedValueOnce(json({ lyrics: 42 }));

    await expect(
      fetchLyricsOvh({ title: "Unknown", artist: "Nobody" }),
    ).resolves.toBeNull();
    await expect(
      fetchLyricsOvh({ title: "Unknown", artist: "Nobody" }),
    ).resolves.toBeNull();
    await expect(
      fetchLyricsOvh({ title: "Unknown", artist: "Nobody" }),
    ).resolves.toBeNull();
  });

  it("skips incomplete hints without a request", async () => {
    await expect(
      fetchLyricsOvh({ title: "  ", artist: "Coldplay" }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives transport errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    await expect(
      fetchLyricsOvh({ title: "Yellow", artist: "Coldplay" }),
    ).resolves.toBeNull();
  });
});
