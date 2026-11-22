import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ searchSoundCloudTracks: vi.fn() }));

vi.mock("@/shared/media/soundcloud", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/media/soundcloud")>();
  return { ...actual, searchSoundCloudTracks: mocks.searchSoundCloudTracks };
});

import { findSoundCloudUploads } from "./soundcloudFallback";
import type { PlayableTrack } from "./playbackStream";

const apollo: PlayableTrack = {
  id: "BKVyNI7f9zc",
  title: "Apollo (Radio Edit)",
  artists: "Astronaut",
  durationMs: 186_000,
};

function hit(
  id: string,
  title: string,
  artist: string,
  durationMs: number,
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
  mocks.searchSoundCloudTracks.mockReset();
});

describe("findSoundCloudUploads", () => {
  it("puts the artist's own channel ahead of a fan upload of the same length", async () => {
    mocks.searchSoundCloudTracks.mockResolvedValue([
      hit("sc:1", "Astronaut - Apollo (Radio Edit) | Fan Page", "Fan Page", 186_000),
      hit("sc:2", "Astronaut - Apollo (Radio Edit)", "Astronaut", 186_000),
    ]);

    await expect(findSoundCloudUploads(apollo)).resolves.toEqual([
      "sc:2",
      "sc:1",
    ]);
  });

  it("never swaps in a tribute or karaoke upload", async () => {
    mocks.searchSoundCloudTracks.mockResolvedValue([
      hit("sc:3", "Apollo (Radio Edit)", "Absolute Astronaut Tribute", 186_000),
      hit("sc:4", "Apollo (Radio Edit) (Karaoke Version)", "Sing King", 186_000),
    ]);

    await expect(findSoundCloudUploads(apollo)).resolves.toEqual([]);
  });

  it("asks both queries at once, with the deeper result limit", async () => {
    mocks.searchSoundCloudTracks.mockResolvedValue([
      hit("sc:5", "Astronaut - Apollo (Radio Edit)", "Astronaut", 186_000),
    ]);

    await findSoundCloudUploads(apollo);

    expect(mocks.searchSoundCloudTracks).toHaveBeenCalledTimes(2);
    for (const call of mocks.searchSoundCloudTracks.mock.calls)
      expect(call[2]).toBe(50);
  });

  it("returns nothing when the searches fail, instead of throwing", async () => {
    mocks.searchSoundCloudTracks.mockRejectedValue(new Error("relay refused"));

    await expect(findSoundCloudUploads(apollo)).resolves.toEqual([]);
  });
});
