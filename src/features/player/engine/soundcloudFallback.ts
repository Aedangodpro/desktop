import {
  searchSoundCloudTracks,
  SOUNDCLOUD_DEEP_SEARCH_LIMIT,
} from "@/shared/media/soundcloud";
import { rethrowIfAborted } from "@/shared/utils/abort";
import { log } from "@/shared/utils/logger";
import { sameRecordingMatch } from "./playbackAlternates";
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

/**
 * SoundCloud uploads of the same recording, closest length first.
 *
 * Both queries go out together: each is one relayed request, and running them
 * in sequence doubled the time this fallback needed to even start. Failures are
 * logged rather than swallowed — a silent empty result here is what made a
 * refused YouTube track look like it never tried another catalog at all.
 */
export async function findSoundCloudUploads(
  track: PlayableTrack,
  signal?: AbortSignal,
): Promise<string[]> {
  const queries = searchQueries(track);
  if (queries.length === 0) return [];

  let lastError: unknown = null;
  const batches = await Promise.all(
    queries.map((query) =>
      searchSoundCloudTracks(query, signal, SOUNDCLOUD_DEEP_SEARCH_LIMIT).catch(
        (error) => {
          rethrowIfAborted(signal);
          lastError = error;
          return [];
        },
      ),
    ),
  );

  const seen = new Set<string>();
  const found: Array<{
    id: string;
    rank: number;
    extraWords: number;
    ownArtist: boolean;
  }> = [];
  for (const hits of batches) {
    for (const hit of hits) {
      if (seen.has(hit.track.id)) continue;
      seen.add(hit.track.id);
      const match = sameRecordingMatch(track, {
        title: hit.track.title,
        artists: hit.track.artists.map((entry) => entry.name),
        // the label's own attribution, not the uploader account: anyone can
        // name an account after an artist they are covering
        ...(hit.publisherArtist ? { publisher: hit.publisherArtist } : {}),
        uploader: hit.uploader,
        uploaderVerified: hit.uploaderVerified,
        durationMs: hit.track.durationMs,
      });
      if (match === null) continue;
      found.push({
        id: hit.track.id,
        rank: match.rank,
        extraWords: match.extraWords,
        ownArtist: match.ownArtist,
      });
    }
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
