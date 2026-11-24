import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/shared/contracts";

const mocks = vi.hoisted(() => ({ searchSoundCloudTracks: vi.fn() }));

vi.mock("@/shared/media/soundcloud", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/media/soundcloud")>();
  return { ...actual, searchSoundCloudTracks: mocks.searchSoundCloudTracks };
});

import { withSoundCloudTracks } from "./catalogSearch";

const catalogTrack: SearchResult = {
  type: "track",
  id: "yt-1",
  title: "Aphex Twin - Xtal",
  artists: [{ id: "uc-1", name: "Aphex Twin" }],
  durationMs: 293_000,
};

afterEach(() => {
  mocks.searchSoundCloudTracks.mockReset();
});

describe("withSoundCloudTracks", () => {
  it("paints the catalog answer before the soundcloud lookup settles", async () => {
    let release: (hits: unknown[]) => void = () => {};
    mocks.searchSoundCloudTracks.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const painted: number[] = [];

    const pending = withSoundCloudTracks(
      "aphex twin xtal",
      "all",
      Promise.resolve({ items: [catalogTrack] }),
      { onPrimary: (items) => painted.push(items.length) },
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // visible while the second catalog is still in flight
    expect(painted).toEqual([1]);

    release([]);
    await expect(pending).resolves.toEqual({ items: [catalogTrack] });
  });

  it("does not search soundcloud for a query that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withSoundCloudTracks(
        "aphex twin xtal",
        "track",
        Promise.resolve({ items: [catalogTrack] }),
        { signal: controller.signal },
      ),
    ).resolves.toEqual({ items: [catalogTrack] });
    expect(mocks.searchSoundCloudTracks).not.toHaveBeenCalled();
  });
});
