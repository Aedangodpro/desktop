import { describe, expect, it } from "vitest";
import { LIVE_BITMAP_BUCKET_MS, liveBitmapKey } from "./sceneLines";

/** Distinct live bitmaps requested over one second at a given frame rate. */
function bitmapsPerSecond(fps: number): number {
  const step = 1000 / fps;
  const keys = new Set<string>();
  for (let t = 0; t < 1000; t += step) keys.add(liveBitmapKey(t, 7));
  return keys.size;
}

describe("live lyric bitmap pacing", () => {
  it("reuses one bitmap inside a bucket", () => {
    expect(liveBitmapKey(0, 7)).toBe(
      liveBitmapKey(LIVE_BITMAP_BUCKET_MS - 0.01, 7),
    );
  });

  it("rebuilds at the bucket boundary", () => {
    expect(liveBitmapKey(LIVE_BITMAP_BUCKET_MS, 7)).not.toBe(
      liveBitmapKey(0, 7),
    );
  });

  it("halves rasterisations on a 200 Hz panel", () => {
    // 200 frames a second, at most one bitmap per 8 ms bucket.
    expect(bitmapsPerSecond(200)).toBeLessThanOrEqual(126);
    expect(bitmapsPerSecond(200)).toBeGreaterThanOrEqual(100);
  });

  it("leaves a 60 Hz panel unchanged", () => {
    // Every frame is already further apart than one bucket.
    expect(bitmapsPerSecond(60)).toBeGreaterThanOrEqual(58);
  });

  it("never reuses a bitmap across a lyric change", () => {
    expect(liveBitmapKey(120, 7)).not.toBe(liveBitmapKey(120, 8));
  });
});
