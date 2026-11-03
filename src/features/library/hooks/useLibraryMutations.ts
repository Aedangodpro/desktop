import { useCallback, useState } from "react";
import {
  api,
  type ApiUserPlaylist,
  type ApiUserPlaylistItem,
} from "@/shared/api";
import type { Track } from "@/shared/types";
import { notifyLibraryChanged, evictPlaylistFromCache } from "./usePlaylists";
import { applyOptimisticLike, applyOptimisticUnlike } from "./useLikedTracks";
import {
  addLocalPlaylistTrack,
  createLocalPlaylist,
  deleteLocalPlaylist,
  isSignedIn,
  likeLocalTrack,
  moveLocalPlaylistItem,
  placeholderTrack,
  readLocalLibrary,
  removeLocalPlaylistItem,
  unlikeLocalTrack,
  type LocalPlaylist,
  type LocalPlaylistItem,
} from "../local-account/store/localLibrary";

type Options = {
  onSuccess?: (...args: any[]) => void;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
};

function useMutation<T, R = unknown>(action: (input: T) => Promise<R>) {
  const [isPending, setIsPending] = useState(false);
  const mutateAsync = useCallback(
    async (input: T): Promise<R> => {
      setIsPending(true);
      try {
        const result = await action(input);
        notifyLibraryChanged();
        return result;
      } finally {
        setIsPending(false);
      }
    },
    [action],
  );
  const mutate = useCallback(
    (input: T, options?: Options) => {
      void mutateAsync(input)
        .then((value) => options?.onSuccess?.(value))
        .catch((error) => options?.onError?.(error))
        .finally(() => options?.onSettled?.());
    },
    [mutateAsync],
  );
  return { mutate, mutateAsync, isPending };
}

export function useAddPlaylistTracks() {
  return useMutation(
    ({
      playlistId,
      trackId,
      track,
    }: {
      playlistId: string;
      trackId: string;
      track?: Track;
    }) => {
      if (!isSignedIn()) {
        const item = addLocalPlaylistTrack(
          playlistId,
          track ?? resolveLocalTrack({ trackId }),
        );
        if (!item) return Promise.reject(new Error("Playlist not found"));
        return Promise.resolve(localItemPayload(item));
      }
      return api.addPlaylistTrack(playlistId, trackId);
    },
  );
}

export function useRemovePlaylistTracks() {
  return useMutation(
    ({ playlistId, itemId }: { playlistId: string; itemId: string }) => {
      if (!isSignedIn()) {
        removeLocalPlaylistItem(playlistId, itemId);
        return Promise.resolve();
      }
      return api.removePlaylistItem(playlistId, itemId);
    },
  );
}

export function useReorderPlaylistTracks() {
  return useMutation(
    ({
      playlistId,
      itemId,
      beforeItemId,
      revision,
    }: {
      playlistId: string;
      itemId: string;
      beforeItemId: string | null;
      revision: number;
    }) => {
      if (!isSignedIn()) {
        moveLocalPlaylistItem(playlistId, itemId, beforeItemId);
        return Promise.resolve({
          playlist: localPlaylistPayload(
            readLocalLibrary().playlists.find(
              (playlist) => playlist.id === playlistId,
            ) ?? {
              id: playlistId,
              title: "",
              createdAt: "",
              updatedAt: "",
              revision: 0,
              items: [],
            },
          ),
          items: (
            readLocalLibrary().playlists.find(
              (playlist) => playlist.id === playlistId,
            )?.items ?? []
          ).map(localItemPayload),
        });
      }
      return api.movePlaylistItem(playlistId, itemId, beforeItemId, revision);
    },
  );
}

export function useCreatePlaylist() {
  return useMutation(
    ({ title, description }: { title: string; description?: string }) => {
      if (!isSignedIn()) {
        return Promise.resolve(
          localPlaylistPayload(createLocalPlaylist({ title, description })),
        );
      }
      return api.createPlaylist({ title, description });
    },
  );
}

export function useDeletePlaylist() {
  return useMutation(async ({ playlistId }: { playlistId: string }) => {
    evictPlaylistFromCache(playlistId);
    if (!isSignedIn()) {
      deleteLocalPlaylist(playlistId);
      return;
    }
    await api.deletePlaylist(playlistId);
  });
}

export function useSaveExternalItem() {
  return useMutation(
    ({
      type,
      id,
      snapshot,
    }: {
      type: "album" | "artist" | "playlist";
      id: string;
      snapshot?: Record<string, unknown>;
    }) =>
      api.saveCollection(
        `${type}s` as "albums" | "artists" | "playlists",
        id,
        snapshot,
      ),
  );
}

export function useRemoveExternalItem() {
  return useMutation(
    async ({
      type,
      id,
      isOwned,
    }: {
      type: "album" | "artist" | "playlist";
      id: string;
      isOwned?: boolean;
    }) => {
      if (type === "playlist") {
        evictPlaylistFromCache(id);
        if (isOwned === false) {
          return api.removeCollection("playlists", id);
        }
        try {
          const res = await api.deletePlaylist(id);
          // purge any saved collection reference in case it was both created and saved
          await api.removeCollection("playlists", id).catch(() => {});
          return res;
        } catch (err: unknown) {
          if (isOwned === true) {
            throw err;
          }
          // fall back to removing from saved collections if playlist was not owned
          return api.removeCollection("playlists", id);
        }
      }
      return api.removeCollection(`${type}s` as "albums" | "artists", id);
    },
  );
}

type TrackMutationInput = string | { trackId: string; [key: string]: unknown };
const trackIdFrom = (input: TrackMutationInput) =>
  typeof input === "string" ? input : input.trackId;

function localItemPayload(item: LocalPlaylistItem): ApiUserPlaylistItem {
  return {
    id: item.id,
    track: item.track as unknown as ApiUserPlaylistItem["track"],
    position: 0,
    addedAt: item.addedAt,
  };
}

function localPlaylistPayload(playlist: LocalPlaylist): ApiUserPlaylist {
  return {
    id: playlist.id,
    title: playlist.title,
    ...(playlist.description ? { description: playlist.description } : {}),
    isPublic: false,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
    revision: playlist.revision,
    trackCount: playlist.items.length,
    coverUrls: playlist.items
      .map((item) => item.track.coverUrl)
      .filter(Boolean)
      .slice(0, 4),
  };
}

// prefers a real snapshot from the caller, then anything already on this device
function resolveLocalTrack(input: TrackMutationInput): Track {
  const trackId = trackIdFrom(input);
  const provided = typeof input === "object" ? input.track : undefined;
  if (provided && typeof provided === "object") return provided as Track;
  const library = readLocalLibrary();
  const liked = library.liked.find((entry) => entry.trackId === trackId);
  if (liked) return liked.track;
  for (const playlist of library.playlists) {
    const item = playlist.items.find((entry) => entry.track.id === trackId);
    if (item) return item.track;
  }
  return placeholderTrack(trackId);
}

export function useLikeTrack() {
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = useCallback(async (input: TrackMutationInput) => {
    const trackId = trackIdFrom(input);
    setIsPending(true);
    const rollback = applyOptimisticLike(trackId);
    try {
      if (!isSignedIn()) {
        likeLocalTrack(resolveLocalTrack(input));
        notifyLibraryChanged();
        return;
      }
      const result = await api.likeTrack(trackId);
      notifyLibraryChanged();
      return result;
    } catch (err) {
      rollback();
      throw err;
    } finally {
      setIsPending(false);
    }
  }, []);

  const mutate = useCallback(
    (input: TrackMutationInput, options?: Options) => {
      void mutateAsync(input)
        .then((value) => options?.onSuccess?.(value))
        .catch((error) => options?.onError?.(error))
        .finally(() => options?.onSettled?.());
    },
    [mutateAsync],
  );

  return { mutate, mutateAsync, isPending };
}

export function useUnlikeTrack() {
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = useCallback(async (input: TrackMutationInput) => {
    const trackId = trackIdFrom(input);
    setIsPending(true);
    const rollback = applyOptimisticUnlike(trackId);
    try {
      if (!isSignedIn()) {
        unlikeLocalTrack(trackId);
        notifyLibraryChanged();
        return;
      }
      const result = await api.unlikeTrack(trackId);
      notifyLibraryChanged();
      return result;
    } catch (err) {
      rollback();
      throw err;
    } finally {
      setIsPending(false);
    }
  }, []);

  const mutate = useCallback(
    (input: TrackMutationInput, options?: Options) => {
      void mutateAsync(input)
        .then((value) => options?.onSuccess?.(value))
        .catch((error) => options?.onError?.(error))
        .finally(() => options?.onSettled?.());
    },
    [mutateAsync],
  );

  return { mutate, mutateAsync, isPending };
}
