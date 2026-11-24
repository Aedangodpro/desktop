import {
  searchSoundCloudTracks,
  SOUNDCLOUD_DEEP_SEARCH_LIMIT,
  type SoundCloudSearchHit,
} from "@/shared/media/soundcloud";
import { rethrowIfAborted } from "@/shared/utils/abort";
import { log } from "@/shared/utils/logger";
import { explainRecordingMatch } from "./playbackAlternates";
import type { PlayableTrack } from "./playbackStream";

/**
 * SoundCloud as the second catalog for a YouTube track.
 *
 * YouTube bot-checks the address a playability call leaves from, and this app's
 * shared host is flagged routinely. When that happens every client is refused
 * for every video — including the re-uploads `playbackAlternates` probes — so
 * no amount of waiting or switching clients helps. SoundCloud answers the same
 * network anonymously, and the same recording is usually uploaded there too,
 * so a refused track still has somewhere to play from.
 *
 * Matching is the re-upload matcher, not the import matcher: same song words,
 * same artist, within ten seconds of the length, and never another mix. Who
 * published an upload is part of that: a cover or an "Arabic Version/Rendition"
 * credits its performer in the catalog metadata, so it is not the artist's
 * recording even though the title quotes the artist and the length lines up.
 */

/**
 * Three uploads: the closest match can be unplayable (region, policy, snip),
 * and each extra candidate only costs a download if the ones before it failed.
 */
const MAX_CANDIDATES = 3;

/**
 * A deep search is 50 hits per query, two queries, and the payload is mapped
 * and matched on the main thread. Most tracks have a playable upload in the
 * first page, so the first pass asks for 20 and only the case that found
 * nothing pays for the deeper one.
 */
const SOUNDCLOUD_FIRST_PASS_LIMIT = 20;

/** Hard ceiling on candidates matched, so a pathological result set stays bounded. */
const MAX_EVALUATED_CANDIDATES = 80;

/** Rejections are logged to explain a wrong pick, not to print a novel. */
const MAX_REJECTION_LOGS = 10;

function searchQueries(track: PlayableTrack): string[] {
  const title = track.title.trim();
  const artist = track.artists.split(",")[0]?.trim() ?? "";
  return [
    ...new Set(
      [`${title} ${artist}`, `${artist} ${title}`]
        .map((query) => query.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
}

interface FoundUpload {
  id: string;
  rank: number;
  extraWords: number;
  ownArtist: boolean;
}

interface SearchResultSet {
  batches: SoundCloudSearchHit[][];
  error: unknown;
}

/**
 * Both queries go out together: each is one relayed request, and running them
 * in sequence doubled the time this fallback needed to even start. Failures are
 * kept rather than swallowed — a silent empty result here is what made a
 * refused YouTube track look like it never tried another catalog at all.
 */
async function searchBoth(
  queries: readonly string[],
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResultSet> {
  let error: unknown = null;
  const batches = await Promise.all(
    queries.map((query) =>
      searchSoundCloudTracks(query, signal, limit).catch((failure) => {
        rethrowIfAborted(signal);
        error = failure;
        return [];
      }),
    ),
  );
  return { batches, error };
}

function evaluate(
  track: PlayableTrack,
  batches: readonly SoundCloudSearchHit[][],
): FoundUpload[] {
  const seen = new Set<string>();
  const found: FoundUpload[] = [];
  let evaluated = 0;
  let rejected = 0;
  let logged = 0;
  for (const hits of batches) {
    for (const hit of hits) {
      if (seen.has(hit.track.id)) continue;
      seen.add(hit.track.id);
      if (evaluated >= MAX_EVALUATED_CANDIDATES) break;
      evaluated += 1;
      const verdict = explainRecordingMatch(track, {
        title: hit.track.title,
        artists: hit.track.artists.map((entry) => entry.name),
        // the label's own attribution, not the uploader account: anyone can
        // name an account after an artist they are covering
        ...(hit.publisherArtist ? { publisher: hit.publisherArtist } : {}),
        uploader: hit.uploader,
        uploaderVerified: hit.uploaderVerified,
        durationMs: hit.track.durationMs,
      });
      const match = verdict.match;
      if (match === null) {
        rejected += 1;
        // Every rejection names the rule that made it, up to a limit: the next
        // wrong-song report can name the upload that was picked *and* what the
        // rules threw away for being closer, without a block of console output
        // per search.
        if (logged < MAX_REJECTION_LOGS) {
          logged += 1;
          log(
            "gray",
            "playback",
            `soundcloud rejected "${hit.track.title}" by ${hit.uploader} for "${track.title}": ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`,
          );
        }
        continue;
      }
      found.push({
        id: hit.track.id,
        rank: match.rank,
        extraWords: match.extraWords,
        ownArtist: match.ownArtist,
      });
    }
  }
  if (rejected > logged) {
    log(
      "gray",
      "playback",
      `soundcloud rejected ${rejected - logged} more uploads for "${track.title}"`,
    );
  }
  return found;
}

/**
 * SoundCloud uploads of the same recording, closest length first.
 */
export async function findSoundCloudUploads(
  track: PlayableTrack,
  signal?: AbortSignal,
): Promise<string[]> {
  const queries = searchQueries(track);
  if (queries.length === 0) return [];

  const first = await searchBoth(queries, SOUNDCLOUD_FIRST_PASS_LIMIT, signal);
  let found = evaluate(track, first.batches);
  let batches = first.batches;
  let lastError = first.error;

  if (found.length === 0 && !signal?.aborted) {
    const deep = await searchBoth(
      queries,
      SOUNDCLOUD_DEEP_SEARCH_LIMIT,
      signal,
    );
    const deepFound = evaluate(track, deep.batches);
    batches = deep.batches;
    lastError = deep.error ?? lastError;
    if (deepFound.length > 0) found = deepFound;
  }

  if (found.length === 0) {
    const total = batches.reduce((sum, hits) => sum + hits.length, 0);
    if (lastError && total === 0)
      log(
        "yellow",
        "playback",
        `soundcloud search failed for "${track.title}": ${String(lastError)}`,
      );
    else
      log(
        "cyan",
        "playback",
        `no soundcloud upload matches "${track.title}" (${total} hits)`,
      );
  }

  return found
    .sort((left, right) => {
      // the artist's own channel first, then the plainest title ("Reggae
      // Version" and "(Igor Blaska Edit)" carry the same length), then length
      if (left.ownArtist !== right.ownArtist) return left.ownArtist ? -1 : 1;
      if (left.extraWords !== right.extraWords)
        return left.extraWords - right.extraWords;
      return left.rank - right.rank;
    })
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.id);
}

export { SOUNDCLOUD_FIRST_PASS_LIMIT, MAX_EVALUATED_CANDIDATES };
