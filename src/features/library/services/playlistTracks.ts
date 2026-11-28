import { api, ApiError } from "@/shared/api";
import type { Track } from "@/shared/contracts";

/**
 * The Worker aborts API requests after 30 s, so a playlist with hundreds of
 * tracks has to be uploaded in batches instead of one oversized request.
 */
export const TRACK_BATCH_SIZE = 50;
const FALLBACK_CONCURRENCY = 4;

async function addOneByOne(
  playlistId: string,
  tracks: Track[],
): Promise<number> {
  let saved = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < tracks.length) {
      const track = tracks[cursor++];
      try {
        await api.addPlaylistTrack(playlistId, track.id, track);
        saved += 1;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) saved += 1;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(FALLBACK_CONCURRENCY, tracks.length) },
      worker,
    ),
  );
  return saved;
}

async function addBatch(playlistId: string, tracks: Track[]): Promise<number> {
  try {
    const result = await api.addPlaylistTrackSnapshots(playlistId, tracks);
    return result.added;
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 405)
    ) {
      return addOneByOne(playlistId, tracks);
    }
    throw error;
  }
}

/** Adds every track, one bounded request at a time. Returns how many landed. */
export async function addTracksToPlaylist(
  playlistId: string,
  tracks: Track[],
): Promise<number> {
  let saved = 0;
  for (let index = 0; index < tracks.length; index += TRACK_BATCH_SIZE) {
    saved += await addBatch(
      playlistId,
      tracks.slice(index, index + TRACK_BATCH_SIZE),
    );
  }
  return saved;
}
