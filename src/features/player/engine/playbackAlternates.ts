import { searchRaw, toVideoId } from "@/shared/youtube";
import { cleanBaseTitle, normalizeWords } from "@/shared/media/matching";
import {
  getChannelPerformanceTags,
  getPerformanceTags,
} from "@/shared/media/matching/performanceTags";
import {
  getChannelVersionTags,
  getVersionTags,
} from "@/shared/media/matching/versionTags";
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
 *
 * The trap it has to avoid is a re-upload of the *song* by somebody else: a
 * guitar arrangement, an "Arabic Version/Rendition", a cover that keeps the
 * original length. Those quote the artist in the title, so a title-word check
 * alone cannot tell them apart from the record. Three things can:
 *
 * - who the catalog says published the upload (`publisher_metadata.artist`),
 *   which is a different name for a cover and the artist for a real re-upload;
 * - whether the uploader account is a verified artist who is not this artist;
 * - whether the title carries a qualifier the release does not.
 */

const DURATION_TOLERANCE_MS = 10_000;
const MAX_CANDIDATES = 3;
/** Without a length, only titles this close to the track are trusted. */
const MAX_UNMEASURED_EXTRA_WORDS = 1;

export interface UploadCandidate {
  title: string;
  /** artists the row credits; on a video catalog this is often the channel */
  artists: readonly string[];
  durationMs: number;
  /**
   * the label's artist tag, where the catalog has one. This is attribution,
   * not a display name: a cover carries its own performer here.
   */
  publisher?: string;
  /**
   * the account that uploaded it. An account name is not evidence of the
   * artist: impersonation pages ("Hello Adele") do exactly this.
   */
  uploader?: string;
  /** the catalog verified the account, so it is a real artist's own page */
  uploaderVerified?: boolean;
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

/** "Tame Impala, Fcukers" names two artists; either can be the release's. */
function artistNameParts(value: string): string[] {
  return value
    .split(/[,&/]|\s(?:and|feat|ft|vs|x)\s/gi)
    .map((part) => normalizeWords(part))
    .filter(Boolean);
}

/**
 * Whether a catalog name is this artist, as opposed to a name that merely
 * contains it. Substring matching is how "Hello Adele" would pass for Adele,
 * so names are compared whole.
 */
function namesArtist(artist: string, name: string): boolean {
  const wanted = normalizeWords(artist);
  if (!wanted) return false;
  return artistNameParts(name).some((part) => part === wanted);
}

/** "The Best of Oasis" vouches for Oasis; "Grace Davies" does not. */
function mentionsArtist(artist: string, name: string): boolean {
  const wanted = normalizeWords(artist).split(" ").filter(Boolean);
  if (wanted.length === 0) return false;
  const available = new Set(normalizeWords(name).split(" "));
  return wanted.every((word) => available.has(word));
}

/** Signals that a title describes another performance or another version. */
function titleSignals(value: string): Set<string> {
  const signals = getVersionTags(value);
  for (const tag of getPerformanceTags(value)) signals.add(tag);
  return signals;
}

/**
 * The same for a channel or account name, from the narrower vocabulary those
 * names can carry: an account called "Bass Nation" or "Live Nation" is not
 * evidence of an instrumental or a concert recording, and treating it as such
 * threw away correct uploads. A channel called "Absolute Journey Tribute" or
 * "Killer Queen Band Page" still disqualifies itself.
 */
function channelSignals(value: string): Set<string> {
  const signals = getChannelVersionTags(value);
  for (const tag of getChannelPerformanceTags(value)) signals.add(tag);
  return signals;
}

const QUALIFIER = /[([]([^)\]]+)[)\]]/g;

function qualifiers(value: string): string[] {
  return [...value.matchAll(QUALIFIER)].map((match) =>
    normalizeWords(match[1] ?? ""),
  );
}

/** bracket filler that says nothing about which recording this is */
const UPLOAD_NOISE = new Set([
  ...RELEASE_WORDS,
  "official",
  "video",
  "audio",
  "music",
  "lyric",
  "lyrics",
  "visualizer",
  "visualiser",
  "mv",
  "m",
  "v",
  "explicit",
  "clean",
  "dirty",
  "free",
  "download",
  "dl",
  "stream",
  "streaming",
  "premiere",
  "out",
  "now",
  "exclusive",
  "4k",
  "1080p",
  "clip",
  "officiel",
]);

function isUploadNoise(qualifier: string): boolean {
  return qualifier
    .split(" ")
    .filter((word) => word.length > 0 && !YEAR_WORD.test(word))
    .every((word) => UPLOAD_NOISE.has(word));
}

/**
 * A bracketed part the release does not have is a version marker: "(Full Step
 * Down)", "(The Arabic Version/Rendition)", "(Piano & Original Voice)". The
 * release's own brackets, and upload furniture like "(Official Video)", stay
 * allowed.
 */
function foreignQualifier(
  sourceTitle: string,
  candidateTitle: string,
): string | null {
  const sourceQualifiers = qualifiers(sourceTitle);
  const sourceText = normalizeWords(sourceTitle);
  for (const qualifier of qualifiers(candidateTitle)) {
    if (!qualifier) continue;
    if (sourceQualifiers.includes(qualifier)) continue;
    if (sourceText.includes(qualifier)) continue;
    if (isUploadNoise(qualifier)) continue;
    return `(${qualifier})`;
  }
  return null;
}

export interface RecordingMatch {
  /** distance in ms (or the unmeasured ranking); smaller is closer */
  rank: number;
  /** words the upload adds to the track's own title and artist */
  extraWords: number;
  /** the artist's own release, rather than a fan or third-party upload */
  ownArtist: boolean;
}

export type RecordingRejection =
  | "empty_title"
  | "duration"
  | "missing_words"
  | "publisher"
  | "unattributed"
  | "verified_other_artist"
  | "version"
  | "extra_words";

export interface RecordingVerdict {
  match: RecordingMatch | null;
  /** set exactly when `match` is null, so a rejected pick can be explained */
  reason?: RecordingRejection;
  /** the evidence behind `reason`: the missing words, the marker, the name */
  detail?: string;
}

function rejected(
  reason: RecordingRejection,
  detail?: string,
): RecordingVerdict {
  return detail ? { match: null, reason, detail } : { match: null, reason };
}

/**
 * How well an upload matches, or why it is a different recording. Measured
 * lengths sort first (by distance); unmeasured ones are ranked by how much
 * noise the title carries. `sameRecordingMatch` is the yes/no view of this.
 */
export function explainRecordingMatch(
  track: PlayableTrack,
  candidate: UploadCandidate,
): RecordingVerdict {
  const title = track.title.trim();
  if (!title || !candidate.title.trim()) return rejected("empty_title");

  const gap = durationGap(track.durationMs, candidate.durationMs);
  if (Number.isFinite(gap) && gap > DURATION_TOLERANCE_MS)
    return rejected("duration", `${Math.round(gap / 1000)}s off`);

  const primaryArtist = track.artists.split(",")[0]?.trim() ?? "";
  // The artist usually lives in the title ("Artist - Song"), so searching the
  // combined words keeps re-uploads from unrelated channels.
  const required = words(primaryArtist ? `${title} ${primaryArtist}` : title);
  const uploader = candidate.uploader?.trim() ?? "";
  const candidateWords = words(
    [candidate.title, ...candidate.artists, uploader]
      .filter(Boolean)
      .join(" "),
  );
  if (!includesAll(candidateWords, required))
    return rejected(
      "missing_words",
      [...required].filter((word) => !candidateWords.has(word)).join(" "),
    );

  // who published it: a cover credits its performer, a real re-upload credits
  // the record's artist (or nobody)
  const publisher = candidate.publisher?.trim() ?? "";
  if (primaryArtist && publisher && !namesArtist(primaryArtist, publisher))
    return rejected("publisher", `published as ${publisher}`);
  const attributedMatch =
    primaryArtist.length > 0 &&
    (namesArtist(primaryArtist, publisher) ||
      candidate.artists.some((name) => namesArtist(primaryArtist, name)));
  const uploaderMatch =
    primaryArtist.length > 0 && namesArtist(primaryArtist, uploader);

  if (primaryArtist && !attributedMatch && !uploaderMatch) {
    // Nobody credits the artist, so the release title has to name it.
    const titleNamesArtist = includesAll(
      words(candidate.title),
      words(primaryArtist),
    );
    // An account can vouch for the artist only when it is named after the artist
    // alone, and not after this song as well: "The Best of Oasis" is a fan
    // page, while "Hello Adele" is how a cover page labels itself.
    const uploaderNamesArtist =
      mentionsArtist(primaryArtist, uploader) &&
      ![...words(title)].some((word) => words(uploader).has(word));
    if (!titleNamesArtist && !uploaderNamesArtist)
      return rejected("unattributed", `uploaded by ${uploader || "nobody"}`);
    // A verified account is an artist's own page: if it is not this artist, the
    // upload is that artist performing this song.
    if (candidate.uploaderVerified)
      return rejected("verified_other_artist", `verified account ${uploader}`);
  }

  const sourceSignals = titleSignals(title);
  const candidateSignals = titleSignals(candidate.title);
  for (const name of [...candidate.artists, uploader].filter(Boolean))
    for (const tag of channelSignals(name)) candidateSignals.add(tag);
  // any version marker the release itself does not carry makes this a
  // different recording. The channel name counts as much as the title: an
  // upload of "Don't Stop Believin'" by "Absolute Journey Tribute" is a
  // re-performance, and "(Igor Blaska Edit)" is not the record that plays
  // under the same title and length. Channel names use the narrower
  // vocabulary, though: "Bass Nation" is not an instrumental.
  for (const tag of candidateSignals) {
    if (!sourceSignals.has(tag)) return rejected("version", tag);
  }
  const foreign = foreignQualifier(title, candidate.title);
  if (foreign) return rejected("version", foreign);

  // title-only: the uploader's own name is not extra title noise
  const extraWords = Math.max(0, words(candidate.title).size - required.size);
  const ownArtist = attributedMatch || uploaderMatch;
  // An upload nobody credits to the artist has to look like the release and
  // nothing else: the title is the song plus the artist, and at most one word
  // of uploader noise. "40 FINGERS - Bohemian Rhapsody Queen" is a cello duo
  // covering it, and no keyword recognises "40 FINGERS".
  if (!ownArtist && extraWords > MAX_UNMEASURED_EXTRA_WORDS)
    return rejected("extra_words", `${extraWords} extra title words`);
  if (!Number.isFinite(gap))
    return {
      match: { rank: DURATION_TOLERANCE_MS + extraWords, extraWords, ownArtist },
    };
  return { match: { rank: gap, extraWords, ownArtist } };
}

/**
 * How well an upload matches, or null when it is a different recording.
 */
export function sameRecordingMatch(
  track: PlayableTrack,
  candidate: UploadCandidate,
): RecordingMatch | null {
  return explainRecordingMatch(track, candidate).match;
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
