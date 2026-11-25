import { useEffect } from "react";
import { api, mediaUrl, toMaxQualityAvatarUrl } from "@/shared/api";
import {
  freshFor,
  revalidateResource,
  useCachedResource,
} from "@/shared/cache/useCachedResource";
import {
  useSessionOwner,
  useSessionSignedIn,
} from "@/features/home/hooks/sessionAwareLoad";
import type { LibraryItemViewModel } from "../types";

export type EntityType = "album" | "artist" | "playlist";

const EMPTY_ITEMS: LibraryItemViewModel[] = [];
const SAVED_ITEMS_POLICY = { isFresh: freshFor(5 * 60_000) };

async function loadSavedItems(
  type: EntityType,
): Promise<LibraryItemViewModel[]> {
  const collectionType =
    type === "album" ? "albums" : type === "artist" ? "artists" : "playlists";
  const response = await api.listSavedCollections(collectionType);
  return response.items.map((entry: any) => {
    const value = entry[type];
    const rawCover = value.cover ? mediaUrl(value.cover.url) : "";
    const cover =
      type === "artist" ? toMaxQualityAvatarUrl(rawCover) : rawCover;
    return {
      id: value.id,
      title: type === "artist" ? value.name : value.title,
      subtitle:
        type === "artist"
          ? "Artist"
          : type === "playlist"
            ? value.author ||
              (value.trackCount ? `${value.trackCount} tracks` : "Playlist")
            : [
                value.year,
                value.trackCount ? `${value.trackCount} tracks` : undefined,
              ]
                .filter(Boolean)
                .join(" • "),
      imageUrl: cover,
      kind: type,
      href:
        type === "artist"
          ? `/artist?id=${encodeURIComponent(value.id)}`
          : type === "playlist"
            ? `/collection?type=playlist&id=${encodeURIComponent(value.id)}`
            : `/collection?type=album&id=${encodeURIComponent(value.id)}`,
      addedAt: entry.savedAt,
      trackCount: value.trackCount,
      isOwned: false,
    };
  });
}

export function useExternalItems(type: EntityType) {
  const owner = useSessionOwner();
  const signedIn = useSessionSignedIn();
  const key = `library:saved:${type}:${owner}`;
  const { data, isLoading } = useCachedResource(
    key,
    () => loadSavedItems(type),
    // Saved collections are account data. Asking for them without a session
    // only collects a 401 on every signed-out library visit.
    { ...SAVED_ITEMS_POLICY, enabled: signedIn },
  );

  useEffect(() => {
    if (!signedIn) return;
    const refresh = () =>
      void revalidateResource(key, () => loadSavedItems(type), { force: true });
    window.addEventListener("library:changed", refresh);
    return () => window.removeEventListener("library:changed", refresh);
  }, [key, type, signedIn]);

  return { data: data ?? EMPTY_ITEMS, isLoading };
}
