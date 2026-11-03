import { getAuthSession } from "@/shared/api";
import type { Track } from "@/shared/types";

/**
 * The on-device library.
 *
 * Without an account there is no server to hold playlists or likes, so they
 * live here instead, in localStorage, in the same shapes the rest of the
 * library UI already renders. Nothing in this module talks to the API: when a
 * session exists the hooks keep using the server and this data is simply not
 * read. Signing in later does not merge the two.
 */

export interface LocalPlaylistItem {
  id: string;
  addedAt: string;
  track: Track;
}

export interface LocalPlaylist {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  items: LocalPlaylistItem[];
}

export interface LocalLikedTrack {
  trackId: string;
  likedAt: string;
  track: Track;
}

export interface LocalLibrary {
  playlists: LocalPlaylist[];
  liked: LocalLikedTrack[];
}

export const LOCAL_LIBRARY_KEY = "liner_local_library_v1";

const listeners = new Set<() => void>();
let cache: LocalLibrary | null = null;

export function emptyLibrary(): LocalLibrary {
  return { playlists: [], liked: [] };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTrack(value: unknown): Track | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  return value as unknown as Track;
}

function readItem(value: unknown): LocalPlaylistItem | null {
  if (!isRecord(value)) return null;
  const track = readTrack(value.track);
  if (typeof value.id !== "string" || !value.id || !track) return null;
  return {
    id: value.id,
    addedAt: typeof value.addedAt === "string" ? value.addedAt : nowIso(),
    track,
  };
}

function readPlaylist(value: unknown): LocalPlaylist | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  const items = Array.isArray(value.items)
    ? value.items
        .map(readItem)
        .filter((item): item is LocalPlaylistItem => item !== null)
    : [];
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : "",
    ...(typeof value.description === "string" && value.description
      ? { description: value.description }
      : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
    revision: typeof value.revision === "number" ? value.revision : 1,
    items,
  };
}

function readLiked(value: unknown): LocalLikedTrack | null {
  if (!isRecord(value)) return null;
  const track = readTrack(value.track);
  const trackId =
    typeof value.trackId === "string" ? value.trackId : (track?.id ?? "");
  if (!trackId || !track) return null;
  return {
    trackId,
    likedAt: typeof value.likedAt === "string" ? value.likedAt : nowIso(),
    track,
  };
}

function sanitize(raw: unknown): LocalLibrary {
  if (!isRecord(raw)) return emptyLibrary();
  const playlists = Array.isArray(raw.playlists)
    ? raw.playlists
        .map(readPlaylist)
        .filter((entry): entry is LocalPlaylist => entry !== null)
    : [];
  const liked = Array.isArray(raw.liked)
    ? raw.liked
        .map(readLiked)
        .filter((entry): entry is LocalLikedTrack => entry !== null)
    : [];
  const seen = new Set<string>();
  return {
    playlists,
    liked: liked.filter((entry) => {
      if (seen.has(entry.trackId)) return false;
      seen.add(entry.trackId);
      return true;
    }),
  };
}

export function readLocalLibrary(): LocalLibrary {
  if (cache) return cache;
  const store = storage();
  if (!store) {
    cache = emptyLibrary();
    return cache;
  }
  try {
    cache = sanitize(JSON.parse(store.getItem(LOCAL_LIBRARY_KEY) ?? "null"));
  } catch {
    cache = emptyLibrary();
  }
  return cache;
}

export function writeLocalLibrary(next: LocalLibrary): void {
  const clean = sanitize(next);
  cache = clean;
  try {
    storage()?.setItem(LOCAL_LIBRARY_KEY, JSON.stringify(clean));
  } catch {}
  listeners.forEach((listener) => listener());
}

export function subscribeLocalLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drops the in-memory copy so the next read comes from storage. */
export function resetLocalLibraryCache(): void {
  cache = null;
}

export function isSignedIn(): boolean {
  try {
    return Boolean(getAuthSession()?.accessToken);
  } catch {
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

function withPlaylists(
  mutate: (playlists: LocalPlaylist[]) => LocalPlaylist[],
): LocalLibrary {
  const library = readLocalLibrary();
  const next = { ...library, playlists: mutate(library.playlists) };
  writeLocalLibrary(next);
  return next;
}

function touch(playlist: LocalPlaylist): LocalPlaylist {
  return { ...playlist, updatedAt: nowIso(), revision: playlist.revision + 1 };
}

export function placeholderTrack(trackId: string): Track {
  return {
    id: trackId,
    title: "",
    artists: "",
    artistId: undefined,
    coverUrl: "",
    durationMs: 0,
    playCount: 0,
  } as Track;
}

export function createLocalPlaylist(input: {
  title: string;
  description?: string;
}): LocalPlaylist {
  const at = nowIso();
  const description = input.description?.trim();
  const playlist: LocalPlaylist = {
    id: newId("local"),
    title: input.title.trim(),
    ...(description ? { description } : {}),
    createdAt: at,
    updatedAt: at,
    revision: 1,
    items: [],
  };
  withPlaylists((playlists) => [playlist, ...playlists]);
  return playlist;
}

export function updateLocalPlaylist(
  id: string,
  patch: { title?: string; description?: string | null },
): LocalPlaylist | null {
  let updated: LocalPlaylist | null = null;
  withPlaylists((playlists) =>
    playlists.map((playlist) => {
      if (playlist.id !== id) return playlist;
      const title = patch.title?.trim() || playlist.title;
      const description =
        patch.description === null
          ? undefined
          : (patch.description?.trim() ?? playlist.description);
      updated = touch({
        ...playlist,
        title,
        ...(description ? { description } : { description: undefined }),
      });
      return updated;
    }),
  );
  return updated;
}

export function deleteLocalPlaylist(id: string): void {
  withPlaylists((playlists) => playlists.filter((playlist) => playlist.id !== id));
}

export function addLocalPlaylistTrack(
  playlistId: string,
  track: Track,
): LocalPlaylistItem | null {
  let result: LocalPlaylistItem | null = null;
  const library = readLocalLibrary();
  const existing = library.playlists.find((playlist) => playlist.id === playlistId);
  if (!existing) return null;

  const already = existing.items.find((item) => item.track.id === track.id);
  if (already) return already;

  const item: LocalPlaylistItem = {
    id: newId("item"),
    addedAt: nowIso(),
    track,
  };
  result = item;
  withPlaylists((playlists) =>
    playlists.map((playlist) =>
      playlist.id === playlistId
        ? touch({ ...playlist, items: [...playlist.items, item] })
        : playlist,
    ),
  );
  return result;
}

export function removeLocalPlaylistItem(
  playlistId: string,
  itemId: string,
): void {
  withPlaylists((playlists) =>
    playlists.map((playlist) =>
      playlist.id === playlistId && playlist.items.some((item) => item.id === itemId)
        ? touch({
            ...playlist,
            items: playlist.items.filter((item) => item.id !== itemId),
          })
        : playlist,
    ),
  );
}

export function moveLocalPlaylistItem(
  playlistId: string,
  itemId: string,
  beforeItemId: string | null,
): void {
  withPlaylists((playlists) =>
    playlists.map((playlist) => {
      if (playlist.id !== playlistId) return playlist;
      const moving = playlist.items.find((item) => item.id === itemId);
      if (!moving) return playlist;
      const rest = playlist.items.filter((item) => item.id !== itemId);
      const index = beforeItemId
        ? rest.findIndex((item) => item.id === beforeItemId)
        : -1;
      const items = [...rest];
      items.splice(index === -1 ? rest.length : index, 0, moving);
      return touch({ ...playlist, items });
    }),
  );
}

export function likeLocalTrack(track: Track): void {
  const library = readLocalLibrary();
  if (library.liked.some((entry) => entry.trackId === track.id)) return;
  writeLocalLibrary({
    ...library,
    liked: [{ trackId: track.id, likedAt: nowIso(), track }, ...library.liked],
  });
}

export function unlikeLocalTrack(trackId: string): void {
  const library = readLocalLibrary();
  writeLocalLibrary({
    ...library,
    liked: library.liked.filter((entry) => entry.trackId !== trackId),
  });
}

export function isLocalTrackLiked(trackId: string): boolean {
  return readLocalLibrary().liked.some((entry) => entry.trackId === trackId);
}
