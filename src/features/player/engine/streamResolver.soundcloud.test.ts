import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/shared/contracts";
import type { Track } from "@/shared/types";

const mocks = vi.hoisted(() => ({
  resolveDirectAudioStream: vi.fn(),
  searchRaw: vi.fn(),
  resolveSoundCloudStream: vi.fn(),
  searchSoundCloudTracks: vi.fn(),
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
  return {
    ...actual,
    resolveSoundCloudStream: mocks.resolveSoundCloudStream,
    searchSoundCloudTracks: mocks.searchSoundCloudTracks,
  };
});

import { SoundCloudUnavailableError } from "@/shared/media/soundcloud";
import { STREAMS_REFUSED_MESSAGE } from "@/shared/youtube";
import { resolvePlaybackStream } from "./streamResolver";
import { clearYoutubeStandInCache } from "./youtubeStandIn";

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

function soundCloudHit(
  id: string,
  title: string,
  durationMs: number,
  artist = "Astronaut",
) {
  return {
    track: {
      type: "track" as const,
      id,
      title,
      artists: artist ? [{ id: "sc_user_1", name: artist }] : [],
      durationMs,
    },
    uploader: artist || "Some Channel",
    plays: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.resolveDirectAudioStream.mockReset();
  mocks.searchRaw.mockReset();
  mocks.resolveSoundCloudStream.mockReset();
  mocks.searchSoundCloudTracks.mockReset();
  clearYoutubeStandInCache();
});

describe("resolvePlaybackStream for soundcloud ids", () => {
  it("plays signed soundcloud urls with their expiry", async () => {
    const expiresAt = "2030-01-01T00:00:00.000Z";
    mocks.resolveSoundCloudStream.mockResolvedValue({
      url: "https://cf-media.sndcdn.com/a.mp3",
      mimeType: "audio/mpeg",
      codec: "mp3",
      bitrate: 128_000,
      expiresAt,
    });

    const stream = await resolvePlaybackStream(track("sc:1099045843"));

    expect(mocks.resolveSoundCloudStream).toHaveBeenCalledWith(
      "sc:1099045843",
      { signal: undefined },
    );
    expect(stream).toMatchObject({
      url: "https://cf-media.sndcdn.com/a.mp3",
      expiresAtMs: Date.parse(expiresAt),
    });
  });

  it("passes buffered hls blobs through without an expiry", async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xfb])], {
      type: "audio/mpeg",
    });
    mocks.resolveSoundCloudStream.mockResolvedValue({
      blob,
      mimeType: "audio/mpeg",
      codec: "mp3",
      bitrate: 128_000,
      expiresAt: null,
      contentLength: 2,
    });

    const stream = await resolvePlaybackStream(track("sc:42"));

    expect(stream).toMatchObject({ blob, expiresAtMs: null, contentLength: 2 });
    expect(stream.url).toBeUndefined();
  });

  it("finds the same song on youtube when soundcloud cannot play it", async () => {
    mocks.resolveSoundCloudStream.mockRejectedValue(
      new SoundCloudUnavailableError("preview_only"),
    );
    mocks.searchRaw.mockResolvedValue([
      searchTrack(
        "aaaaaaaaaa1",
        "Blinding Lights (Live)",
        "The Weeknd",
        260_000,
      ),
      searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_040),
    ]);
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    const stream = await resolvePlaybackStream(track("sc:7"));

    expect(mocks.resolveDirectAudioStream).toHaveBeenCalledWith("4NRXx6U8ABQ", {
      signal: undefined,
    });
    expect(stream).toMatchObject({ url: directStream.url });
  });

  it("remembers the youtube stand-in so the next resolve skips the search", async () => {
    mocks.resolveSoundCloudStream.mockRejectedValue(new Error("network down"));
    mocks.searchRaw.mockResolvedValue([
      searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_040),
    ]);
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    await resolvePlaybackStream(track("sc:8"));
    const searches = mocks.searchRaw.mock.calls.length;
    await resolvePlaybackStream(track("sc:8"));

    expect(mocks.searchRaw).toHaveBeenCalledTimes(searches);
  });

  it("surfaces the soundcloud error when every fallback fails", async () => {
    mocks.resolveSoundCloudStream.mockRejectedValue(
      new SoundCloudUnavailableError("not_found"),
    );
    mocks.searchRaw.mockResolvedValue([]);

    await expect(resolvePlaybackStream(track("sc:10"))).rejects.toThrow(
      "not_found",
    );
  });

  it("plays the same recording from soundcloud when youtube refuses the track", async () => {
    mocks.resolveDirectAudioStream.mockRejectedValue(
      new Error("This track cannot be played in this browser right now."),
    );
    mocks.searchRaw.mockResolvedValue([]);
    mocks.searchSoundCloudTracks.mockResolvedValue([
      soundCloudHit("sc:102180160", "Astronaut - Apollo (Electro Mix)", 262_000),
      soundCloudHit("sc:102180256", "Astronaut - Apollo (Radio Edit)", 186_000),
    ]);
    mocks.resolveSoundCloudStream.mockResolvedValue({
      url: "https://cf-media.sndcdn.com/apollo.mp3",
      mimeType: "audio/mpeg",
      codec: "mp3",
      bitrate: 160_000,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    const stream = await resolvePlaybackStream(
      track("BKVyNI7f9zc", "Apollo (Radio Edit)", "Astronaut", 186_000),
    );

    // the electro mix is 76s longer, so only the radio edit is a candidate
    expect(mocks.resolveSoundCloudStream).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSoundCloudStream).toHaveBeenCalledWith("sc:102180256", {
      signal: undefined,
    });
    expect(stream).toMatchObject({
      source: "soundcloud",
      standIn: true,
      url: "https://cf-media.sndcdn.com/apollo.mp3",
    });
  });

  it("goes straight to soundcloud when the network refuses every youtube client", async () => {
    mocks.resolveDirectAudioStream.mockRejectedValue(
      new Error(`${STREAMS_REFUSED_MESSAGE} (IOS: refused).`),
    );
    mocks.searchSoundCloudTracks.mockResolvedValue([
      soundCloudHit("sc:7", "Astronaut - Apollo (Radio Edit)", 186_000),
    ]);
    mocks.resolveSoundCloudStream.mockResolvedValue({
      url: "https://cf-media.sndcdn.com/apollo.mp3",
      mimeType: "audio/mpeg",
      codec: "mp3",
      bitrate: 160_000,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    const stream = await resolvePlaybackStream(
      track("BKVyNI7f9zc", "Apollo (Radio Edit)", "Astronaut", 186_000),
    );

    // a network-wide refusal means another upload would be refused too, so the
    // stand-in probes are skipped and the other catalog is used directly
    expect(mocks.searchRaw).not.toHaveBeenCalled();
    expect(mocks.resolveSoundCloudStream).toHaveBeenCalledWith("sc:7", {
      signal: undefined,
    });
    expect(stream).toMatchObject({ source: "soundcloud", standIn: true });
  });

  it("stops the unused soundcloud search when a youtube replacement plays", async () => {
    mocks.resolveDirectAudioStream
      .mockRejectedValueOnce(
        new Error("This track cannot be played in this browser right now."),
      )
      .mockResolvedValue(directStream);
    mocks.searchRaw.mockResolvedValue([
      searchTrack("repl0000001", "Apollo (Radio Edit)", "Astronaut", 186_000),
    ]);
    let searchSignal: AbortSignal | undefined;
    mocks.searchSoundCloudTracks.mockImplementation(
      (_query: string, signal: AbortSignal) => {
        searchSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );

    const stream = await resolvePlaybackStream(
      track("BKVyNI7f9zc", "Apollo (Radio Edit)", "Astronaut", 186_000),
    );

    expect(stream).toMatchObject({ standIn: true });
    expect(searchSignal?.aborted).toBe(true);
  });

  it("reports the youtube refusal when soundcloud has no matching upload", async () => {
    const refusal = new Error(
      "This track cannot be played in this browser right now.",
    );
    mocks.resolveDirectAudioStream.mockRejectedValue(refusal);
    mocks.searchRaw.mockResolvedValue([]);
    mocks.searchSoundCloudTracks.mockResolvedValue([
      soundCloudHit("sc:1", "Someone Else - Apollo (Radio Edit)", 186_000, ""),
    ]);

    await expect(
      resolvePlaybackStream(
        track("BKVyNI7f9zc", "Apollo (Radio Edit)", "Astronaut", 186_000),
      ),
    ).rejects.toThrow(refusal.message);
    expect(mocks.resolveSoundCloudStream).not.toHaveBeenCalled();
  });

  it("does not fall back when the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.resolveSoundCloudStream.mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );

    await expect(
      resolvePlaybackStream(track("sc:11"), controller.signal),
    ).rejects.toThrow("aborted");
    expect(mocks.searchRaw).not.toHaveBeenCalled();
  });
});
