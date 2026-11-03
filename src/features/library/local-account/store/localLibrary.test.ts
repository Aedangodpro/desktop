import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import {
  LOCAL_LIBRARY_KEY,
  addLocalPlaylistTrack,
  createLocalPlaylist,
  deleteLocalPlaylist,
  isLocalTrackLiked,
  likeLocalTrack,
  moveLocalPlaylistItem,
  readLocalLibrary,
  removeLocalPlaylistItem,
  resetLocalLibraryCache,
  unlikeLocalTrack,
} from "./localLibrary";
import {
  clearGuestMode,
  enableGuestMode,
  isGuestMode,
} from "@/features/auth/lib/guestMode";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const track = (id: string): Track =>
  ({
    id,
    title: `Song ${id}`,
    artists: "Artist",
    coverUrl: `https://covers.test/${id}.jpg`,
    durationMs: 1000,
    playCount: 0,
  }) as Track;

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  resetLocalLibraryCache();
  clearGuestMode();
});

describe("on-device library", () => {
  it("keeps a created playlist across a reload", () => {
    const created = createLocalPlaylist({ title: "Late night" });
    resetLocalLibraryCache();

    const library = readLocalLibrary();
    expect(library.playlists).toHaveLength(1);
    expect(library.playlists[0]).toMatchObject({
      id: created.id,
      title: "Late night",
      revision: 1,
    });
    expect(localStorage.getItem(LOCAL_LIBRARY_KEY)).toContain("Late night");
  });

  it("adds a track once and moves the revision forward", () => {
    const playlist = createLocalPlaylist({ title: "Mix" });
    addLocalPlaylistTrack(playlist.id, track("a"));
    addLocalPlaylistTrack(playlist.id, track("a"));

    const afterDuplicate = readLocalLibrary().playlists[0]!;
    expect(afterDuplicate.items).toHaveLength(1);
    expect(afterDuplicate.revision).toBe(2);

    addLocalPlaylistTrack(playlist.id, track("b"));
    expect(
      readLocalLibrary().playlists[0]!.items.map((item) => item.track.id),
    ).toEqual(["a", "b"]);
  });

  it("removes and reorders tracks by item id", () => {
    const playlist = createLocalPlaylist({ title: "Order" });
    const a = addLocalPlaylistTrack(playlist.id, track("a"))!;
    addLocalPlaylistTrack(playlist.id, track("b"));
    const c = addLocalPlaylistTrack(playlist.id, track("c"))!;

    moveLocalPlaylistItem(playlist.id, c.id, a.id);
    expect(
      readLocalLibrary().playlists[0]!.items.map((item) => item.track.id),
    ).toEqual(["c", "a", "b"]);

    removeLocalPlaylistItem(playlist.id, a.id);
    expect(
      readLocalLibrary().playlists[0]!.items.map((item) => item.track.id),
    ).toEqual(["c", "b"]);
  });

  it("likes a track once and unlikes it", () => {
    likeLocalTrack(track("x"));
    likeLocalTrack(track("x"));
    expect(readLocalLibrary().liked).toHaveLength(1);
    expect(isLocalTrackLiked("x")).toBe(true);

    unlikeLocalTrack("x");
    expect(isLocalTrackLiked("x")).toBe(false);
  });

  it("deletes a playlist and its items", () => {
    const playlist = createLocalPlaylist({ title: "Gone" });
    addLocalPlaylistTrack(playlist.id, track("a"));
    deleteLocalPlaylist(playlist.id);
    expect(readLocalLibrary().playlists).toHaveLength(0);
  });

  it("starts empty instead of throwing on unreadable storage", () => {
    localStorage.setItem(LOCAL_LIBRARY_KEY, "{not json");
    resetLocalLibraryCache();
    expect(readLocalLibrary()).toEqual({ playlists: [], liked: [] });
  });
});

describe("guest mode", () => {
  it("remembers that the visitor chose to continue without an account", () => {
    expect(isGuestMode()).toBe(false);
    enableGuestMode();
    expect(isGuestMode()).toBe(true);
    clearGuestMode();
    expect(isGuestMode()).toBe(false);
  });
});
