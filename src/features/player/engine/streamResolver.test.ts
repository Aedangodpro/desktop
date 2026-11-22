import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/shared/contracts";
import type { Track } from "@/shared/types";

const mocks = vi.hoisted(() => ({
  resolveDirectAudioStream: vi.fn(),
  searchRaw: vi.fn(),
  resolveSoundCloudStream: vi.fn(),
}));

vi.mock("@/shared/youtube", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/youtube")>();
  return {
    ...actual,
    resolveDirectAudioStream: mocks.resolveDirectAudioStream,
    searchRaw: mocks.searchRaw,
  };
});

vi.mock("@/shared/media/soundcloud", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/media/soundcloud")>();
  return { ...actual, resolveSoundCloudStream: mocks.resolveSoundCloudStream };
});

import { resolvePlaybackStream } from "./streamResolver";
import { clearYoutubeStandInCache } from "./youtubeStandIn";
import { clearExactSongVersions } from "./exactSongVersion";

const directStream = {
  url: "https://rr1.googlevideo.com/videoplayback?itag=251",
  mimeType: "audio/webm",
  codec: "opus" as const,
  bitrate: 135_000,
  itag: 251,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

function track(
  id: string,
  title = "Blinding Lights",
  artists = "The Weeknd",
  durationMs = 200_000,
): Track {
  return { id, title, artists, durationMs, coverUrl: "", playCount: 0 };
}

function searchTrack(
  id: string,
  title: string,
  artist: string,
  durationMs: number,
): SearchResult {
  return {
    type: "track",
    id,
    title,
    artists: [{ id: `UC_${artist}`, name: artist }],
    durationMs,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.resolveDirectAudioStream.mockReset();
  mocks.searchRaw.mockReset();
  mocks.resolveSoundCloudStream.mockReset();
  clearYoutubeStandInCache();
});

describe("resolvePlaybackStream for youtube ids", () => {
  it("plays youtube tracks straight from googlevideo", async () => {
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    const stream = await resolvePlaybackStream(track("dQw4w9WgXcQ"));

    expect(stream).toMatchObject({
      url: directStream.url,
      expiresAtMs: Date.parse(directStream.expiresAt),
    });
    expect(mocks.resolveSoundCloudStream).not.toHaveBeenCalled();
  });

  it("surfaces the innertube error when youtube cannot play the track", async () => {
    mocks.searchRaw.mockResolvedValue([]);
    mocks.resolveDirectAudioStream.mockRejectedValue(
      new Error("LOGIN_REQUIRED"),
    );

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).rejects.toThrow(
      "LOGIN_REQUIRED",
    );
  });

  it("plays another upload when youtube bot-checks the song video", async () => {
    mocks.searchRaw.mockResolvedValue([
      searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_000),
    ]);
    mocks.resolveDirectAudioStream
      .mockRejectedValueOnce(
        new Error("This track cannot be played in this browser right now."),
      )
      .mockResolvedValueOnce(directStream);

    const stream = await resolvePlaybackStream(track("dQw4w9WgXcQ"));

    expect(mocks.resolveDirectAudioStream).toHaveBeenNthCalledWith(
      2,
      "4NRXx6U8ABQ",
      { signal: undefined },
    );
    expect(stream).toMatchObject({ url: directStream.url, standIn: true });
  });

  it("keeps the original failure when the stand-in is refused too", async () => {
    mocks.searchRaw.mockResolvedValue([
      searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_000),
    ]);
    mocks.resolveDirectAudioStream.mockRejectedValue(
      new Error("This track cannot be played in this browser right now."),
    );

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).rejects.toThrow(
      "This track cannot be played in this browser right now.",
    );
  });

  it("plays a re-upload the catalog matcher rejects", async () => {
    mocks.searchRaw.mockResolvedValue([
      searchTrack(
        "bpRHSP8VKFA",
        "Astronaut - Apollo (Radio Edit) | Vylen",
        "Vylen",
        186_000,
      ),
    ]);
    mocks.resolveDirectAudioStream
      .mockRejectedValueOnce(
        new Error("This track cannot be played in this browser right now."),
      )
      .mockResolvedValueOnce(directStream);

    const stream = await resolvePlaybackStream(
      track("BKVyNI7f9zc", "Apollo (Radio Edit)", "Astronaut", 186_000),
    );

    expect(mocks.resolveDirectAudioStream).toHaveBeenNthCalledWith(
      2,
      "bpRHSP8VKFA",
      { signal: undefined },
    );
    expect(stream).toMatchObject({ url: directStream.url, standIn: true });
  });

  it("never retries the refused video as its own stand-in", async () => {
    mocks.searchRaw.mockResolvedValue([
      searchTrack("dQw4w9WgXcQ", "Blinding Lights", "The Weeknd", 200_000),
    ]);
    mocks.resolveDirectAudioStream.mockRejectedValue(
      new Error("This track cannot be played in this browser right now."),
    );

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).rejects.toThrow(
      "This track cannot be played in this browser right now.",
    );
    expect(mocks.resolveDirectAudioStream).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePlaybackStream for ids of unknown sources", () => {
  it("plays the matching youtube track", async () => {
    mocks.searchRaw.mockResolvedValue([
      searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_040),
    ]);
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    const stream = await resolvePlaybackStream(track("local-file-1"));

    expect(mocks.resolveDirectAudioStream).toHaveBeenCalledWith("4NRXx6U8ABQ", {
      signal: undefined,
    });
    expect(stream).toMatchObject({ url: directStream.url });
  });

  it("fails when youtube has no matching track", async () => {
    mocks.searchRaw.mockResolvedValue([]);

    await expect(resolvePlaybackStream(track("local-file-2"))).rejects.toThrow(
      "No matching YouTube track found",
    );
  });
});

describe("resolvePlaybackStream for album rows that are not the song", () => {
  afterEach(() => clearExactSongVersions());

  it("plays the exact song version instead of the music video", async () => {
    mocks.searchRaw.mockResolvedValue([
      searchTrack("Fb3j_yuFh1s", "Blinding Lights", "The Weeknd", 200_000),
    ]);
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    await resolvePlaybackStream({
      ...track("NLZRYQMLDW4"),
      audioVariant: "music-video",
    });

    expect(mocks.resolveDirectAudioStream).toHaveBeenCalledWith("Fb3j_yuFh1s", {
      signal: undefined,
    });
  });

  it("keeps the album row when nothing matches exactly", async () => {
    mocks.searchRaw.mockResolvedValue([
      searchTrack(
        "Fb3j_yuFh1s",
        "Blinding Lights (Remix)",
        "The Weeknd",
        200_000,
      ),
    ]);
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    await resolvePlaybackStream({
      ...track("jvDZEoEdjzo"),
      audioVariant: "premium-only",
    });

    expect(mocks.resolveDirectAudioStream).toHaveBeenCalledWith("jvDZEoEdjzo", {
      signal: undefined,
    });
  });

  it("never searches for tracks that are already the song", async () => {
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    await resolvePlaybackStream(track("dQw4w9WgXcQ"));

    expect(mocks.searchRaw).not.toHaveBeenCalled();
  });
});
