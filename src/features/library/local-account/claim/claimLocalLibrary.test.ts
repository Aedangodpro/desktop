// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api";
import {
  addLocalPlaylistTrack,
  createLocalPlaylist,
  likeLocalTrack,
  readLocalLibrary,
  resetLocalLibraryCache,
  writeLocalLibrary,
} from "../store/localLibrary";
import { claimLocalLibrary, pendingLocalClaim } from "./claimLocalLibrary";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function track(id: string) {
  return {
    id,
    title: `Track ${id}`,
    artists: "Some Artist",
    coverUrl: "https://img.test/cover.jpg",
    durationMs: 1000,
    playCount: 0,
  };
}

function createdPlaylist(id: string) {
  return { id } as Awaited<ReturnType<typeof api.createPlaylist>>;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorage());
  resetLocalLibraryCache();
  writeLocalLibrary({ playlists: [], liked: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetLocalLibraryCache();
});

describe("claimLocalLibrary", () => {
  it("creates one account playlist, marks it, and does not repeat itself", async () => {
    const create = vi
      .spyOn(api, "createPlaylist")
      .mockResolvedValue(createdPlaylist("pl_1"));
    const bulk = vi
      .spyOn(api, "addPlaylistTrackSnapshots")
      .mockResolvedValue({ items: [], added: 2, rejected: 0 });

    const playlist = createLocalPlaylist({ title: "Road trip" });
    addLocalPlaylistTrack(playlist.id, track("t1"));
    addLocalPlaylistTrack(playlist.id, track("t2"));

    expect(pendingLocalClaim()).toEqual({
      playlists: 1,
      tracks: 2,
      liked: 0,
    });

    await expect(claimLocalLibrary()).resolves.toEqual({
      playlists: 1,
      tracks: 2,
      liked: 0,
      failed: 0,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledTimes(1);

    const stored = readLocalLibrary().playlists[0];
    expect(stored.remoteId).toBe("pl_1");
    expect(stored.claimedAt).toBeTruthy();
    expect(pendingLocalClaim().playlists).toBe(0);

    await claimLocalLibrary();
    expect(create).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledTimes(1);
  });

  it("uploads large playlists in bounded batches", async () => {
    vi.spyOn(api, "createPlaylist").mockResolvedValue(
      createdPlaylist("pl_big"),
    );
    const bulk = vi
      .spyOn(api, "addPlaylistTrackSnapshots")
      .mockImplementation(async (_id, tracks) => ({
        items: [],
        added: tracks.length,
        rejected: 0,
      }));

    const playlist = createLocalPlaylist({ title: "Big" });
    for (let index = 0; index < 120; index++) {
      addLocalPlaylistTrack(playlist.id, track(`t${index}`));
    }

    const result = await claimLocalLibrary();

    expect(bulk.mock.calls.map(([, tracks]) => tracks.length)).toEqual([
      50, 50, 20,
    ]);
    expect(result).toMatchObject({ tracks: 120, failed: 0 });
  });

  it("claims likes and advances the marker only after they land", async () => {
    const like = vi.spyOn(api, "likeTrack").mockResolvedValue(undefined);
    likeLocalTrack(track("t1"));

    await expect(claimLocalLibrary()).resolves.toMatchObject({
      liked: 1,
      failed: 0,
    });
    expect(like).toHaveBeenCalledWith("t1");
    expect(pendingLocalClaim().liked).toBe(0);

    await claimLocalLibrary();
    expect(like).toHaveBeenCalledTimes(1);
  });

  it("leaves a playlist pending when creating its account copy fails", async () => {
    vi.spyOn(api, "createPlaylist").mockRejectedValue(new Error("offline"));

    const playlist = createLocalPlaylist({ title: "Later" });
    addLocalPlaylistTrack(playlist.id, track("t1"));

    await expect(claimLocalLibrary()).resolves.toMatchObject({ failed: 1 });
    expect(pendingLocalClaim().playlists).toBe(1);
    expect(readLocalLibrary().playlists[0].remoteId).toBeUndefined();
  });
});
