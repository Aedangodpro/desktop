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
  extra: {
    uploader?: string;
    publisherArtist?: string;
    uploaderVerified?: boolean;
  } = {},
) {
  return {
    track: {
      type: "track" as const,
      id,
      title,
      artists: artist ? [{ id: "sc_user_1", name: artist }] : [],
      durationMs,
    },
    uploader: extra.uploader ?? artist ?? "Some Channel",
    uploaderVerified: extra.uploaderVerified ?? false,
    ...(extra.publisherArtist
      ? { publisherArtist: extra.publisherArtist }
      : {}),
    plays: 0,
  };
}

afterEach(() => {
  mocks.searchSoundCloudTracks.mockReset();
});

describe("findSoundCloudUploads", () => {
  it("puts the artist's own channel ahead of a fan upload of the same length", async () => {
    mocks.searchSoundCloudTracks.mockResolvedValue([
      hit("sc:1", "Astronaut - Apollo (Radio Edit) | MrMoM", "MrMoM", 186_000),
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
      hit(
        "sc:4",
        "Apollo (Radio Edit) (Karaoke Version)",
        "Sing King",
        186_000,
      ),
    ]);

    await expect(findSoundCloudUploads(apollo)).resolves.toEqual([]);
  });

  it("skips a re-performance the catalog credits to another artist", async () => {
    const loser: PlayableTrack = {
      id: "loserVid",
      title: "Loser",
      artists: "Tame Impala",
      durationMs: 224_000,
    };
    mocks.searchSoundCloudTracks.mockResolvedValue([
      hit(
        "sc:6",
        "Loser - Tame Impala (The Arabic Version/Rendition)",
        "YAD Oud",
        226_000,
        {
          uploader: "YAD Oud",
          publisherArtist: "YAD Oud",
        },
      ),
      hit("sc:7", "Loser", "Hello Adele", 224_000, { uploader: "Hello Adele" }),
    ]);

    await expect(findSoundCloudUploads(loser)).resolves.toEqual([]);
  });

  it("skips a cover published on the covering artist's verified page", async () => {
    const hello: PlayableTrack = {
      id: "helloVid",
      title: "Hello",
      artists: "Adele",
      durationMs: 296_000,
    };
    mocks.searchSoundCloudTracks.mockResolvedValue([
      hit("sc:8", "Hello - Adele", "Grace Davies", 301_000, {
        uploader: "Grace Davies",
        uploaderVerified: true,
      }),
    ]);

    await expect(findSoundCloudUploads(hello)).resolves.toEqual([]);
  });

  it("logs why each rejected candidate was thrown away", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      });
    try {
      mocks.searchSoundCloudTracks.mockResolvedValue([
        hit(
          "sc:10",
          "Astronaut - Apollo (Radio Edit) (Karaoke Version)",
          "Sing King",
          186_000,
        ),
      ]);
      await expect(findSoundCloudUploads(apollo)).resolves.toEqual([]);
    } finally {
      spy.mockRestore();
    }

    const output = lines.join("\n");
    expect(output).toContain(
      "Astronaut - Apollo (Radio Edit) (Karaoke Version)",
    );
    expect(output).toContain("by Sing King");
    expect(output).toContain("version (karaoke)");
  });

  it("asks both queries at once, with the first page's limit", async () => {
    mocks.searchSoundCloudTracks.mockResolvedValue([
      hit("sc:5", "Astronaut - Apollo (Radio Edit)", "Astronaut", 186_000),
    ]);

    await findSoundCloudUploads(apollo);

    expect(mocks.searchSoundCloudTracks).toHaveBeenCalledTimes(2);
    for (const call of mocks.searchSoundCloudTracks.mock.calls)
      expect(call[2]).toBe(20);
  });

  it("deepens the search only when the first page had no match", async () => {
    mocks.searchSoundCloudTracks.mockImplementation(
      async (_query: string, _signal?: AbortSignal, limit?: number) =>
        limit === 50
          ? [
              hit(
                "sc:9",
                "Astronaut - Apollo (Radio Edit)",
                "Astronaut",
                186_400,
              ),
            ]
          : [],
    );

    await expect(findSoundCloudUploads(apollo)).resolves.toEqual(["sc:9"]);

    const limits = mocks.searchSoundCloudTracks.mock.calls.map(
      (call) => call[2],
    );
    expect(limits).toEqual([20, 20, 50, 50]);
  });

  it("returns nothing when the searches fail, instead of throwing", async () => {
    mocks.searchSoundCloudTracks.mockRejectedValue(new Error("relay refused"));

    await expect(findSoundCloudUploads(apollo)).resolves.toEqual([]);
  });
});
