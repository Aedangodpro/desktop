import { api } from "@/shared/api";
import type { Track } from "@/shared/contracts";
import type { Track as LocalTrack } from "@/shared/types";
import {
  addLocalPlaylistTrack,
  createLocalPlaylist,
  isSignedIn,
} from "@/features/library/local-account/store/localLibrary";
import { addTracksToPlaylist } from "../../playlistTracks";

export interface FinalizedPlaylist {
  playlistId: string;
  saved: number;
}

function uniqueTracks(tracks: Track[]): Track[] {
  return [
    ...new Map(
      tracks
        .filter((track) => Boolean(track?.id))
        .map((track) => [track.id, track] as const),
    ).values(),
  ];
}

function toLocalTrack(track: Track): LocalTrack {
  return {
    id: track.id,
    title: track.title,
    artists: track.artists.map((artist) => artist.name).join(", "),
    artistList: track.artists,
    coverUrl: track.cover?.url ?? "",
    durationMs: track.durationMs ?? 0,
    playCount: 0,
    ...(track.album ? { album: track.album } : {}),
    ...(track.explicit !== undefined ? { explicit: track.explicit } : {}),
    ...(track.audioVariant ? { audioVariant: track.audioVariant } : {}),
  };
}

function saveLocalImport(
  title: string,
  description: string | undefined,
  tracks: Track[],
): FinalizedPlaylist {
  const playlist = createLocalPlaylist({
    title: title.trim().slice(0, 200) || "Imported playlist",
    ...(description?.trim()
      ? { description: description.trim().slice(0, 2000) }
      : {}),
  });
  let saved = 0;
  for (const track of uniqueTracks(tracks)) {
    if (addLocalPlaylistTrack(playlist.id, toLocalTrack(track))) saved += 1;
  }
  return { playlistId: playlist.id, saved };
}

export async function finalizeImportedPlaylist(
  title: string,
  description: string | undefined,
  tracks: Track[],
): Promise<FinalizedPlaylist> {
  // Signed-out playlists live in the on-device library; sending the import to
  // the account API would only answer 401 and lose the matched tracks.
  if (!isSignedIn())
    return Promise.resolve(saveLocalImport(title, description, tracks));
  const playlist = await api.createPlaylist({
    title: title.trim().slice(0, 200) || "Imported playlist",
    ...(description?.trim()
      ? { description: description.trim().slice(0, 2000) }
      : {}),
  });
  const unique = uniqueTracks(tracks);
  const saved =
    unique.length > 0 ? await addTracksToPlaylist(playlist.id, unique) : 0;
  return { playlistId: playlist.id, saved };
}
