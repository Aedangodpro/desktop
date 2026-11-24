import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import {
  resetPlaybackFailureMemo,
  resolvePlaybackStream,
} from "./streamResolver";
import { clearYoutubeStandInCache } from "./youtubeStandIn";

const directStream = {
  url: "https://rr1.googlevideo.com/videoplayback?itag=251",
  mimeType: "audio/webm",
  codec: "opus" as const,
  bitrate: 135_000,
  itag: 251,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

function track(id: string): Track {
  return {
    id,
    title: "Blinding Lights",
    artists: "The Weeknd",
    durationMs: 200_000,
    coverUrl: "",
    playCount: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.resolveDirectAudioStream.mockReset();
  mocks.searchRaw.mockReset();
  mocks.resolveSoundCloudStream.mockReset();
  mocks.searchSoundCloudTracks.mockReset();
  clearYoutubeStandInCache();
  resetPlaybackFailureMemo();
});

describe("failed resolution memo", () => {
  // the second catalog is a network call; these tests are about the chain
  beforeEach(() => {
    mocks.searchSoundCloudTracks.mockResolvedValue([]);
  });

  it("does not walk the whole fallback chain again for a track that just failed", async () => {
    mocks.searchRaw.mockResolvedValue([]);
    mocks.resolveDirectAudioStream.mockRejectedValue(
      new Error("LOGIN_REQUIRED"),
    );
    const unplayable = track("dQw4w9WgXcQ");

    await expect(resolvePlaybackStream(unplayable)).rejects.toThrow(
      "LOGIN_REQUIRED",
    );
    const providerCalls = mocks.resolveDirectAudioStream.mock.calls.length;
    const searchCalls = mocks.searchRaw.mock.calls.length;

    // a second attempt (the runtime's recovery reload, a skip back, a double
    // click) reports the same failure without re-probing every provider
    await expect(resolvePlaybackStream(unplayable)).rejects.toThrow(
      "LOGIN_REQUIRED",
    );
    expect(mocks.resolveDirectAudioStream).toHaveBeenCalledTimes(providerCalls);
    expect(mocks.searchRaw).toHaveBeenCalledTimes(searchCalls);
  });

  it("forgets the failure when a later resolve succeeds", async () => {
    mocks.searchRaw.mockResolvedValue([]);
    mocks.resolveDirectAudioStream
      .mockRejectedValueOnce(new Error("LOGIN_REQUIRED"))
      .mockResolvedValue(directStream);
    const flaky = track("4NRXx6U8ABQ");

    await expect(resolvePlaybackStream(flaky)).rejects.toThrow(
      "LOGIN_REQUIRED",
    );
    resetPlaybackFailureMemo(flaky.id);
    await expect(resolvePlaybackStream(flaky)).resolves.toMatchObject({
      url: directStream.url,
    });
    // the success clears the entry, so the next resolve goes to the provider
    const calls = mocks.resolveDirectAudioStream.mock.calls.length;
    await resolvePlaybackStream(flaky);
    expect(mocks.resolveDirectAudioStream.mock.calls.length).toBe(calls + 1);
  });

  it("does not let a speculative preload poison a deliberate play", async () => {
    mocks.searchRaw.mockResolvedValue([]);
    mocks.resolveDirectAudioStream
      .mockRejectedValueOnce(new Error("LOGIN_REQUIRED"))
      .mockResolvedValue(directStream);
    const warmed = track("Fb3j_yuFh1s");

    await expect(
      resolvePlaybackStream(warmed, undefined, { recordFailure: false }),
    ).rejects.toThrow("LOGIN_REQUIRED");

    await expect(resolvePlaybackStream(warmed)).resolves.toMatchObject({
      url: directStream.url,
    });
  });
});
