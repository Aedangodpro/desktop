import type { SearchResult } from "@/shared/contracts";
import {
  cleanBaseTitle,
  isSameRecording,
  recordingProfile,
} from "@/shared/media/matching";
import type { SoundCloudSearchHit } from "@/shared/media/soundcloud";
import { isRelevantSearchHit, searchRelevance } from "./searchRelevance";
import { soundCloudHitScore } from "./soundCloudHitScore";

type TrackResult = Extract<SearchResult, { type: "track" }>;

interface ScoredTrack {
  track: TrackResult;
  score: number;
}

const CROSS_PLATFORM_BONUS = 0.1;

function isTrack(item: SearchResult): item is TrackResult {
  return item.type === "track";
}

function byScore(left: ScoredTrack, right: ScoredTrack): number {
  return right.score - left.score;
}

/**
 * Comparing every upload with every catalog hit is what made the merge cost
 * ~30 ms of main thread per result set (see `matchingCost.test.ts`). Two titles
 * can only be the same recording when they share a word, so the comparisons are
 * indexed by title word: an upload is checked against the handful of hits that
 * share one of its words instead of all of them.
 */
const MIN_BUCKET_TOKEN_LENGTH = 2;

function titleTokens(title: string): string[] {
  return [
    ...new Set(
      cleanBaseTitle(title)
        .split(" ")
        .filter((token) => token.length >= MIN_BUCKET_TOKEN_LENGTH),
    ),
  ];
}

function bucketTracks(
  index: Map<string, ScoredTrack[]>,
  hit: ScoredTrack,
): void {
  for (const token of titleTokens(hit.track.title)) {
    const bucket = index.get(token);
    if (bucket) bucket.push(hit);
    else index.set(token, [hit]);
  }
}

function twinsOf(
  index: Map<string, ScoredTrack[]>,
  title: string,
): ScoredTrack[] {
  const seen = new Set<ScoredTrack>();
  const twins: ScoredTrack[] = [];
  for (const token of titleTokens(title)) {
    for (const hit of index.get(token) ?? []) {
      if (seen.has(hit)) continue;
      seen.add(hit);
      twins.push(hit);
    }
  }
  return twins;
}

function uniqueSoundCloud(
  query: string,
  youtube: ScoredTrack[],
  soundcloud: SoundCloudSearchHit[],
): ScoredTrack[] {
  const kept: ScoredTrack[] = [];
  const youtubeIndex = new Map<string, ScoredTrack[]>();
  for (const hit of youtube) bucketTracks(youtubeIndex, hit);
  const keptIndex = new Map<string, ScoredTrack[]>();
  const candidates = soundcloud
    .filter((hit) => isRelevantSearchHit(query, hit.track))
    .map((hit, rank) => ({
      track: hit.track,
      publisherArtists: hit.publisherArtist ? [hit.publisherArtist] : [],
      score: soundCloudHitScore(query, hit, rank),
    }))
    .sort(byScore);
  for (const candidate of candidates) {
    const profile = recordingProfile(
      candidate.track,
      candidate.publisherArtists,
    );
    const twin = twinsOf(youtubeIndex, candidate.track.title).find((hit) =>
      isSameRecording(profile, hit.track),
    );
    if (twin) {
      twin.score += CROSS_PLATFORM_BONUS;
      continue;
    }
    const duplicate = twinsOf(keptIndex, candidate.track.title).some((hit) =>
      isSameRecording(profile, hit.track),
    );
    if (duplicate) continue;
    const scored = { track: candidate.track, score: candidate.score };
    kept.push(scored);
    bucketTracks(keptIndex, scored);
  }
  return kept;
}

function interleave(
  youtube: ScoredTrack[],
  soundcloud: ScoredTrack[],
): TrackResult[] {
  const merged: TrackResult[] = [];
  let left = 0;
  let right = 0;
  while (left < youtube.length || right < soundcloud.length) {
    const takeYoutube =
      right >= soundcloud.length ||
      (left < youtube.length && youtube[left].score >= soundcloud[right].score);
    merged.push(
      takeYoutube ? youtube[left++].track : soundcloud[right++].track,
    );
  }
  return merged;
}

function placeTracks(
  primary: SearchResult[],
  tracks: TrackResult[],
): SearchResult[] {
  const trackSlots = primary.filter(isTrack).length;
  if (trackSlots === 0) {
    const anchor = Math.min(1, primary.length);
    return [...primary.slice(0, anchor), ...tracks, ...primary.slice(anchor)];
  }
  const queue = [...tracks];
  let seenSlots = 0;
  return primary.flatMap((item): SearchResult[] => {
    if (!isTrack(item)) return [item];
    seenSlots += 1;
    const next = queue.shift() ?? item;
    return seenSlots === trackSlots ? [next, ...queue.splice(0)] : [next];
  });
}

export function mergeSoundCloudTracks(
  query: string,
  primary: SearchResult[],
  soundcloud: SoundCloudSearchHit[],
): SearchResult[] {
  if (soundcloud.length === 0) return primary;
  const youtube = primary.filter(isTrack).map((track, rank) => ({
    track,
    score: searchRelevance(query, track, rank),
  }));
  const extra = uniqueSoundCloud(query, youtube, soundcloud);
  if (extra.length === 0) return primary;
  return placeTracks(primary, interleave(youtube, extra));
}
