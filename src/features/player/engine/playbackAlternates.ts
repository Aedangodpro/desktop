import { searchRaw, toVideoId } from "@/shared/youtube";
import { cleanBaseTitle, getVersionTags } from "@/shared/media/matching";
import type { PlayableTrack } from "./playbackStream";

/**
 * Finding a playable upload for a track whose own video YouTube refused.
 *
 * The catalog matcher behind imports is deliberately strict: it is deciding
 * whether two records are the same release, so it rejects anything with a
 * different artist tag, a different version tag or a duration that drifts. A
 * playback fallback needs the same song, not the same release: the only
 * playable upload of "Apollo (Radio Edit)" is titled
 * "Astronaut - Apollo (Radio Edit) | Vylen", which the strict matcher throws
 * away. This filter keeps the parts that make an upload the same recording
 * (song words, artist, version, length) and ignores uploader noise.
 */

/** A different mix is a different recording, so never swap one in. */
const OTHER_RECORDING_TAGS = new Set([
  "remix",
  "vip",
  "flip",
  "bootleg",
  "mashup",
  "slowed",
  "reverb",
  "sped_up",
  "nightcore",
  "instrumental",
  "acoustic",
  "live",
  "cover",
  "bass_boosted",
]);

const DURATION_TOLERANCE_MS = 10_000;
const MAX_CANDIDATES = 3;

export interface UploadCandidate {
  title: string;
  artists: readonly string[];
  durationMs: number;
}

function words(value: string): Set<string> {
  return new Set(
    cleanBaseTitle(value)
      .split(" ")
      .filter((word) => word.length > 0),
  );
}

function includesAll(value: Set<string>, required: Set<string>): boolean {
  for (const word of required) if (!value.has(word)) return false;
  return true;
}

function durationGap(trackMs: number, candidateMs: number): number {
  return trackMs > 0 && candidateMs > 0
    ? Math.abs(trackMs - candidateMs)
    : Number.POSITIVE_INFINITY;
}

export function isSameRecordingUpload(
  track: PlayableTrack,
  candidate: UploadCandidate,
): boolean {
  const title = track.title.trim();
  if (!title || !candidate.title.trim()) return false;

  const gap = durationGap(track.durationMs, candidate.durationMs);
  if (gap > DURATION_TOLERANCE_MS) return false;

  const candidateWords = words(
    [candidate.title, ...candidate.artists].join(" "),
  );
  if (!includesAll(candidateWords, words(title))) return false;

  // The artist usually lives in the title ("Artist - Song"), so searching the
  // combined words keeps re-uploads from unrelated channels.
  const primaryArtist = track.artists.split(",")[0]?.trim() ?? "";
  if (primaryArtist && !includesAll(candidateWords, words(primaryArtist)))
    return false;

  const sourceTags = getVersionTags(title);
  for (const tag of getVersionTags(candidate.title)) {
    if (OTHER_RECORDING_TAGS.has(tag) && !sourceTags.has(tag)) return false;
  }
  return true;
}

/**
 * Uploads of the same recording, closest duration first, so the caller can try
 * them until one resolves.
 */
export async function findAlternateUploads(
  track: PlayableTrack,
  refusedVideoId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const title = track.title.trim();
  const artist = track.artists.trim();
  if (!title) return [];

  const queries = [
    ...new Set(
      [`${title} ${artist}`, `${artist} ${title}`]
        .map((query) => query.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
  const seen = new Set([refusedVideoId]);
  const found: Array<{ id: string; gap: number }> = [];

  for (const query of queries) {
    const results = await searchRaw(query, undefined, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return [];
    });
    for (const result of results) {
      if (result.type !== "track") continue;
      const id = toVideoId(result.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const candidate = {
        title: result.title,
        artists: result.artists.map((entry) => entry.name),
        durationMs: result.durationMs,
      };
      if (!isSameRecordingUpload(track, candidate)) continue;
      found.push({ id, gap: durationGap(track.durationMs, result.durationMs) });
    }
    if (found.length >= MAX_CANDIDATES) break;
  }

  return found
    .sort((left, right) => left.gap - right.gap)
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.id);
}
