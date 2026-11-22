import { toVideoId } from "@/shared/youtube";
import { findCatalogMatch } from "@/shared/media/matching";
import type { PlayableTrack } from "./playbackStream";

const matchedVideoIds = new Map<string, string>();

export function clearYoutubeStandInCache(): void {
  matchedVideoIds.clear();
}

export async function findYoutubeStandIn(
  track: PlayableTrack,
  signal?: AbortSignal,
  excludeVideoId?: string,
): Promise<string | null> {
  const remembered = matchedVideoIds.get(track.id);
  if (remembered && remembered !== excludeVideoId) return remembered;
  const artist = track.artists.trim();
  if (!track.title.trim()) return null;
  const outcome = await findCatalogMatch(
    {
      sourceId: track.id,
      title: track.title,
      artists: artist ? [artist] : [],
      ...(track.durationMs > 0 ? { durationMs: track.durationMs } : {}),
    },
    signal,
    excludeVideoId ? { excludeIds: [excludeVideoId] } : undefined,
  );
  if (outcome.status !== "approved") return null;
  const videoId = toVideoId(outcome.track.id);
  if (videoId && videoId !== excludeVideoId)
    matchedVideoIds.set(track.id, videoId);
  return videoId;
}
