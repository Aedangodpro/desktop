import { describe, expect, it } from "vitest";
import {
  explainRecordingMatch,
  type UploadCandidate,
} from "@/features/player/engine/playbackAlternates";
import type { PlayableTrack } from "@/features/player/engine/playbackStream";
import type { SearchResult } from "@/shared/contracts";
import { mergeSoundCloudTracks } from "./mergeSoundCloudTracks";
import { searchRelevance } from "./searchRelevance";

/**
 * Cost guard for the two places that compare a search result set against a
 * track: the SoundCloud playback fallback (up to two searches of 50 hits) and
 * the SoundCloud merge in the catalog search (every debounced keystroke).
 *
 * These run on the main thread, so their cost is part of the time between a
 * keypress and the results being painted. The bounds are deliberately loose —
 * they only catch an order-of-magnitude regression, not a slow machine.
 */

function candidate(index: number): UploadCandidate {
  // the shapes a real deep SoundCloud search returns: the right upload, other
  // mixes, covers, tribute channels and unrelated songs by channels that happen
  // to share a word with the query
  const shapes = [
    () => ({
      title: "Apollo (Radio Edit)",
      artists: ["Astronaut"],
      durationMs: 186_000,
    }),
    () => ({
      title: "Astronaut - Apollo (Radio Edit) | MrMoM",
      artists: ["MrMoM"],
      durationMs: 186_400,
    }),
    () => ({
      title: "Apollo (Radio Edit) (Karaoke Version)",
      artists: ["Sing King"],
      durationMs: 186_000,
    }),
    () => ({
      title: "Apollo (Extended Mix)",
      artists: ["Astronaut"],
      durationMs: 402_000,
    }),
    () => ({
      title: "Astronaut - Apollo (Radio Edit) (The Arabic Version/Rendition)",
      artists: ["YAD Oud"],
      durationMs: 187_000,
    }),
    () => ({
      title: "Apollo",
      artists: ["Some Channel"],
      durationMs: 186_000,
    }),
  ] as const;
  const shape = shapes[index % shapes.length]();
  return {
    ...shape,
    uploader: shape.artists[0] ?? "Some Channel",
    uploaderVerified: index % 7 === 0,
    ...(index % 3 === 0 ? { publisher: "Astronaut" } : {}),
  };
}

const track: PlayableTrack = {
  id: "BKVyNI7f9zc",
  title: "Apollo (Radio Edit)",
  artists: "Astronaut",
  durationMs: 186_000,
};

function time(label: string, runs: number, fn: () => void): number {
  for (let warm = 0; warm < 3; warm++) fn();
  const samples: number[] = [];
  for (let run = 0; run < runs; run++) {
    const startedAt = performance.now();
    fn();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  const best = samples[0];
  console.log(
    `[matching-cost] ${label}: median ${median.toFixed(2)}ms, best ${best.toFixed(2)}ms (${runs} runs)`,
  );
  return median;
}

function youtubeTrack(index: number): SearchResult {
  return {
    type: "track",
    id: `yt_${index}`,
    title:
      index % 2 === 0
        ? `Apollo (Radio Edit) ${index}`
        : `Some Other Song ${index}`,
    artists: [
      { id: "a", name: index % 2 === 0 ? "Astronaut" : "Another Artist" },
    ],
    durationMs: 186_000 + index * 1_000,
  } as SearchResult;
}

function soundCloudHit(index: number) {
  const shape = candidate(index);
  return {
    track: {
      type: "track" as const,
      id: `sc:${index}`,
      title: shape.title,
      artists: shape.artists.map((name) => ({ id: "u", name })),
      durationMs: shape.durationMs,
    },
    uploader: shape.uploader ?? "Some Channel",
    uploaderVerified: shape.uploaderVerified ?? false,
    ...(shape.publisher ? { publisherArtist: shape.publisher } : {}),
    plays: index * 100,
  };
}

describe("transitional / merge cost", () => {
  it("filters a deep SoundCloud fallback result set in a few milliseconds", () => {
    const candidates = Array.from({ length: 100 }, (_, index) =>
      candidate(index),
    );
    const median = time("100 fallback candidates", 12, () => {
      for (const entry of candidates) explainRecordingMatch(track, entry);
    });
    expect(median).toBeLessThan(400);
  });

  it("merges 20 SoundCloud hits into 25 catalog hits cheaply", () => {
    const primary = Array.from({ length: 25 }, (_, index) =>
      youtubeTrack(index),
    );
    const soundcloud = Array.from({ length: 20 }, (_, index) =>
      soundCloudHit(index),
    );
    const median = time("merge 25 catalog + 20 soundcloud", 12, () => {
      mergeSoundCloudTracks("astronaut apollo", primary, soundcloud);
    });
    expect(median).toBeLessThan(250);
  });

  it("scores search relevance without rebuilding every string", () => {
    const hits = Array.from({ length: 40 }, (_, index) => soundCloudHit(index));
    const median = time("40 relevance scores", 12, () => {
      hits.forEach((hit, index) =>
        searchRelevance("astronaut apollo", hit.track, index),
      );
    });
    expect(median).toBeLessThan(120);
  });
});
