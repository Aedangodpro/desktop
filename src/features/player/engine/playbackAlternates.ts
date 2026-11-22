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
  // an edit is a re-cut of the song: "(Igor Blaska Edit)" is not the record
  // that plays under the same title and length
  "edit",
  "tribute",
  "karaoke",
]);

const DURATION_TOLERANCE_MS = 10_000;
const MAX_CANDIDATES = 3;
/** Without a length, only titles this close to the track are trusted. */
const MAX_UNMEASURED_EXTRA_WORDS = 1;

export interface UploadCandidate {
  title: string;
  artists: readonly string[];
  durationMs: number;
}

const YEAR_WORD = /^(?:19|20)\d{2}$/;
/**
 * Release noise that `cleanBaseTitle` leaves behind when it sits inside
 * brackets ("I Want to Know What Love Is (1999 Remaster)" keeps both words).
 * These do not identify a recording: two remasters of one song are the same
 * song, and requiring the year is how a perfect match (same artist, same
 * length, "(2008 Remaster)") got thrown away.
 */
const RELEASE_WORDS = new Set([
  "remaster",
  "remastered",
  "remasterd",
  "deluxe",
  "anniversary",
  "edition",
  "version",
  "mix",
  "mono",
  "stereo",
  "hq",
  "hd",
]);

/** the words that actually identify the song (and the artist) */
function words(value: string): Set<string> {
  return new Set(
    cleanBaseTitle(value)
      .split(" ")
      .filter(
        (word) =>
          word.length > 0 &&
          !YEAR_WORD.test(word) &&
          !RELEASE_WORDS.has(word),
      ),
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

export interface RecordingMatch {
  /** distance in ms (or the unmeasured ranking); smaller is closer */
  rank: number;
  /** words the upload adds to the track's own title and artist */
  extraWords: number;
}

/**
 * How well an upload matches, or null when it is a different recording.
 * Measured lengths sort first (by distance); unmeasured ones are ranked by how
 * much noise the title carries.
 */
export function sameRecordingMatch(
  track: PlayableTrack,
  candidate: UploadCandidate,
): RecordingMatch | null {
  const title = track.title.trim();
  if (!title || !candidate.title.trim()) return null;

  const gap = durationGap(track.durationMs, candidate.durationMs);
  if (Number.isFinite(gap) && gap > DURATION_TOLERANCE_MS) return null;

  // The artist usually lives in the title ("Artist - Song"), so searching the
  // combined words keeps re-uploads from unrelated channels.
  const primaryArtist = track.artists.split(",")[0]?.trim() ?? "";
  const required = words(primaryArtist ? `${title} ${primaryArtist}` : title);
  const candidateWords = words(
    [candidate.title, ...candidate.artists].join(" "),
  );
  if (!includesAll(candidateWords, required)) return null;

  const sourceTags = getVersionTags(title);
  // the channel name carries the tag as often as the title does: an upload of
  // "Don't Stop Believin'" by "Absolute Journey Tribute" is a re-performance
  const candidateTags = getVersionTags(
    [candidate.title, ...candidate.artists].join(" "),
  );
  for (const tag of candidateTags) {
    if (OTHER_RECORDING_TAGS.has(tag) && !sourceTags.has(tag)) return null;
  }

  const extraWords = candidateWords.size - required.size;
  if (!Number.isFinite(gap)) {
    if (extraWords > MAX_UNMEASURED_EXTRA_WORDS) return null;
    return { rank: DURATION_TOLERANCE_MS + extraWords, extraWords };
  }
  return { rank: gap, extraWords };
}

export function sameRecordingRank(
  track: PlayableTrack,
  candidate: UploadCandidate,
): number | null {
  return sameRecordingMatch(track, candidate)?.rank ?? null;
}

export function isSameRecordingUpload(
  track: PlayableTrack,
  candidate: UploadCandidate,
): boolean {
  return sameRecordingRank(track, candidate) !== null;
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
      const rank = sameRecordingRank(track, candidate);
      if (rank === null) continue;
      found.push({ id, gap: rank });
    }
    if (found.length >= MAX_CANDIDATES) break;
  }

  return found
    .sort((left, right) => left.gap - right.gap)
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.id);
}
