import { searchSoundCloudTracks } from "@/shared/media/soundcloud";
import { sameRecordingRank } from "./playbackAlternates";
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
 * same artist, within ten seconds of the length, and never another mix.
 */

/** Two uploads are plenty: each one costs a full track download. */
const MAX_CANDIDATES = 2;

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

/** SoundCloud uploads of the same recording, closest length first. */
export async function findSoundCloudUploads(
  track: PlayableTrack,
  signal?: AbortSignal,
): Promise<string[]> {
  const queries = searchQueries(track);
  if (queries.length === 0) return [];

  const seen = new Set<string>();
  const found: Array<{ id: string; rank: number }> = [];
  for (const query of queries) {
    const hits = await searchSoundCloudTracks(query, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return [];
    });
    for (const hit of hits) {
      if (seen.has(hit.track.id)) continue;
      seen.add(hit.track.id);
      const rank = sameRecordingRank(track, {
        title: hit.track.title,
        artists: [
          ...hit.track.artists.map((artist) => artist.name),
          hit.uploader,
        ],
        durationMs: hit.track.durationMs,
      });
      if (rank === null) continue;
      found.push({ id: hit.track.id, rank });
    }
    if (found.length >= MAX_CANDIDATES) break;
  }

  return found
    .sort((left, right) => left.rank - right.rank)
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.id);
}
