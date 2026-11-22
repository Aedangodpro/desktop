import type { SearchResult } from "@/shared/contracts";
import {
  asArray,
  asRecord,
  numberValue,
  trimmedString,
} from "@/shared/utils/json";
import { getJson } from "./soundcloudCatalogRequest";
import { mapSoundCloudCatalogTrack } from "./soundcloudMappers";
import { isClearStreamFormat } from "./soundcloudTranscodings";

export type SoundCloudSearchTrack = Extract<SearchResult, { type: "track" }>;

export interface SoundCloudSearchHit {
  track: SoundCloudSearchTrack;
  uploader: string;
  publisherArtist?: string;
  plays: number;
}

const SEARCH_LIMIT = 20;
/** the playback fallback looks deeper: the playable upload is rarely the first */
export const SOUNDCLOUD_DEEP_SEARCH_LIMIT = 50;
const UNPLAYABLE_POLICIES = new Set(["SNIP", "BLOCK"]);

/**
 * A hit is only worth offering if a stream can actually be opened for it: a
 * monetized track lists DRM-only transcodings, and picking one used to cost a
 * whole resolve (and a failed track) before the next candidate was tried.
 */
function hasClearAudio(rawTrack: unknown): boolean {
  const media = asRecord(asRecord(rawTrack)?.media);
  const transcodings = asArray(media?.transcodings);
  // payloads without media cannot be judged here; the resolve step decides
  if (transcodings.length === 0) return true;
  return transcodings.some((raw) => {
    const transcoding = asRecord(raw);
    const format = asRecord(transcoding?.format);
    return isClearStreamFormat(
      trimmedString(format?.protocol) ?? "",
      (trimmedString(format?.mime_type) ?? "").toLowerCase(),
      transcoding?.snipped === true,
    );
  });
}

function isPlayable(rawTrack: unknown): boolean {
  const track = asRecord(rawTrack);
  if (!track || track.streamable === false) return false;
  const policy = trimmedString(track.policy)?.toUpperCase();
  if (policy && UNPLAYABLE_POLICIES.has(policy)) return false;
  return hasClearAudio(rawTrack);
}

function toSearchHit(rawTrack: unknown): SoundCloudSearchHit[] {
  const track = mapSoundCloudCatalogTrack(rawTrack);
  const record = asRecord(rawTrack);
  const uploader = trimmedString(asRecord(record?.user)?.username);
  if (!track || !record || !uploader) return [];
  const publisherArtist = trimmedString(
    asRecord(record.publisher_metadata)?.artist,
  );
  return [
    {
      track: { ...track, type: "track" },
      uploader,
      ...(publisherArtist ? { publisherArtist } : {}),
      plays: numberValue(record.playback_count) ?? 0,
    },
  ];
}

export async function searchSoundCloudTracks(
  query: string,
  signal?: AbortSignal,
  limit: number = SEARCH_LIMIT,
): Promise<SoundCloudSearchHit[]> {
  const body = await getJson(
    "/search/tracks",
    { q: query, limit: String(limit) },
    signal,
  );
  return asArray(body.collection).filter(isPlayable).flatMap(toSearchHit);
}
