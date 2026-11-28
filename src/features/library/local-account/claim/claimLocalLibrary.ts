import { api } from "@/shared/api";
import type { Track as ApiTrack } from "@/shared/contracts";
import { isLocalTrackId } from "@/shared/media/local/localTrackIds";
import type { Track } from "@/shared/types";
import { addTracksToPlaylist } from "@/features/library/services/playlistTracks";
import {
  markLocalLikedClaimed,
  markLocalPlaylistClaimed,
  readLocalLibrary,
  setLocalPlaylistRemoteId,
  type LocalLikedTrack,
  type LocalPlaylist,
  type LocalPlaylistItem,
} from "../store/localLibrary";

/**
 * Copies the on-device library into the signed-in account.
 *
 * Every step is recorded in the local library itself (`remoteId`, `claimedAt`)
 * so a reload, a retry or a failed upload never creates a second copy. The
 * local library stays in place after a claim: signing out still shows what was
 * saved on this device.
 *
 * Local files (`local_…` ids) cannot be uploaded, and playlists that hold none
 * of their own tracks are left alone rather than creating empty copies.
 */

export interface LocalClaimPending {
  playlists: number;
  tracks: number;
  liked: number;
}

export interface LocalClaimResult {
  playlists: number;
  tracks: number;
  liked: number;
  failed: number;
}

const CLAIM_PROMPT_KEY = "liner_local_claim_prompt_v1";
const LIKE_CONCURRENCY = 4;

function parse(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** True when `value` is newer than the marker, or the marker is unusable. */
function isAfter(value: string, mark: string | undefined): boolean {
  const time = parse(value);
  if (time === null) return false;
  const limit = parse(mark);
  return limit === null || time > limit;
}

function newest(values: string[]): string | undefined {
  let latest: string | undefined;
  for (const value of values) {
    if (!latest || isAfter(value, latest)) latest = value;
  }
  return latest;
}

function claimableItems(playlist: LocalPlaylist): LocalPlaylistItem[] {
  return playlist.items.filter(
    (item) =>
      !isLocalTrackId(item.track.id) &&
      isAfter(item.addedAt, playlist.claimedAt),
  );
}

function claimableLikes(): {
  entries: LocalLikedTrack[];
  claimedAt: string | undefined;
} {
  const library = readLocalLibrary();
  return {
    entries: library.liked.filter(
      (entry) =>
        !isLocalTrackId(entry.trackId) &&
        isAfter(entry.likedAt, library.likedClaimedAt),
    ),
    claimedAt: library.likedClaimedAt,
  };
}

export function pendingLocalClaim(): LocalClaimPending {
  let playlists = 0;
  let tracks = 0;
  for (const playlist of readLocalLibrary().playlists) {
    const items = claimableItems(playlist);
    if (items.length === 0) continue;
    playlists += 1;
    tracks += items.length;
  }
  return { playlists, tracks, liked: claimableLikes().entries.length };
}

function toApiTrack(track: Track): ApiTrack {
  const artists = (track.artistList ?? []).map((artist) => ({
    id: artist.id ?? "",
    name: artist.name,
  }));
  if (artists.length === 0) {
    artists.push({
      id: track.artistId ?? "",
      name: track.artists || "Unknown artist",
    });
  }
  const cover = track.coverUrl
    ? { url: track.coverUrl, width: 640, height: 640 }
    : undefined;
  return {
    id: track.id,
    title: track.title || "Unknown title",
    artists,
    durationMs: track.durationMs ?? 0,
    ...(track.album ? { album: track.album } : {}),
    ...(cover ? { cover } : {}),
    ...(track.explicit !== undefined ? { explicit: track.explicit } : {}),
    ...(track.audioVariant ? { audioVariant: track.audioVariant } : {}),
  };
}

async function claimPlaylists(
  onProgress: (done: number) => void,
): Promise<{ playlists: number; tracks: number; failed: number }> {
  let created = 0;
  let uploaded = 0;
  let failed = 0;

  for (const playlist of readLocalLibrary().playlists) {
    const items = claimableItems(playlist);
    if (items.length === 0) continue;

    try {
      let remoteId = playlist.remoteId;
      if (!remoteId) {
        const remote = await api.createPlaylist({
          title: playlist.title.trim().slice(0, 200) || "Imported playlist",
          ...(playlist.description?.trim()
            ? { description: playlist.description.trim().slice(0, 2000) }
            : {}),
        });
        remoteId = remote.id;
        // Persist the pairing before uploading: a reload mid-upload retries
        // into this same account playlist instead of creating another one.
        setLocalPlaylistRemoteId(playlist.id, remoteId);
        created += 1;
      }

      uploaded += await addTracksToPlaylist(
        remoteId,
        items.map((item) => toApiTrack(item.track)),
      );

      markLocalPlaylistClaimed(
        playlist.id,
        remoteId,
        newest([
          ...(playlist.claimedAt ? [playlist.claimedAt] : []),
          ...items.map((item) => item.addedAt),
        ]) ?? new Date().toISOString(),
      );
    } catch {
      failed += 1;
    } finally {
      onProgress(items.length);
    }
  }

  return { playlists: created, tracks: uploaded, failed };
}

async function claimLikes(
  onProgress: (done: number) => void,
): Promise<{ liked: number; failed: number }> {
  const { entries, claimedAt } = claimableLikes();
  if (entries.length === 0) return { liked: 0, failed: 0 };

  let liked = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        await api.likeTrack(entry.trackId);
        liked += 1;
      } catch {
        failed += 1;
      } finally {
        onProgress(1);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LIKE_CONCURRENCY, entries.length) }, worker),
  );

  // Only advance the marker when every like landed; a retry is idempotent.
  if (failed === 0) {
    const latest = newest([
      ...(claimedAt ? [claimedAt] : []),
      ...entries.map((entry) => entry.likedAt),
    ]);
    if (latest) markLocalLikedClaimed(latest);
  }

  return { liked, failed };
}

export async function claimLocalLibrary(options?: {
  onProgress?: (done: number, total: number) => void;
}): Promise<LocalClaimResult> {
  const pending = pendingLocalClaim();
  const total = pending.tracks + pending.liked;
  let done = 0;
  const report = (amount: number) => {
    done += amount;
    options?.onProgress?.(Math.min(done, total), total);
  };

  report(0);
  const playlists = await claimPlaylists(report);
  const likes = await claimLikes(report);
  const result: LocalClaimResult = {
    playlists: playlists.playlists,
    tracks: playlists.tracks,
    liked: likes.liked,
    failed: playlists.failed + likes.failed,
  };

  if (
    typeof window !== "undefined" &&
    (result.tracks > 0 || result.liked > 0)
  ) {
    window.dispatchEvent(new Event("library:changed"));
  }
  return result;
}

function readDismissedAt(): string | undefined {
  try {
    return localStorage.getItem(CLAIM_PROMPT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the "bring your library" prompt should stay quiet. Declining hides
 * it until the on-device library changes, so a later import asks again.
 */
export function isClaimPromptDismissed(): boolean {
  const dismissedAt = readDismissedAt();
  if (!dismissedAt) return false;
  const latest = newest([
    ...readLocalLibrary().playlists.map((playlist) => playlist.updatedAt),
    ...readLocalLibrary().liked.map((entry) => entry.likedAt),
  ]);
  if (!latest) return true;
  return !isAfter(latest, dismissedAt);
}

export function dismissClaimPrompt(): void {
  try {
    localStorage.setItem(CLAIM_PROMPT_KEY, new Date().toISOString());
  } catch {}
}
