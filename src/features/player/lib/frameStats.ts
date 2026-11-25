export interface FrameStats {
  fps: number;
  /** 95th percentile frame time in milliseconds. */
  p95Ms: number;
  samples: number;
}

/**
 * Summarises one window of rAF deltas. FPS is the mean of the window, so it
 * matches what the panel is presenting rather than the single best frame; p95
 * is the frame time only 5% of frames exceed, which is the number that shows
 * stutter a smooth average hides.
 */
export function frameStats(deltas: readonly number[]): FrameStats | null {
  let total = 0;
  let samples = 0;
  for (const delta of deltas) {
    if (!Number.isFinite(delta) || delta <= 0) continue;
    total += delta;
    samples += 1;
  }
  if (samples < 2) return null;

  const sorted = deltas
    .filter((delta) => Number.isFinite(delta) && delta > 0)
    .sort((a, b) => a - b);
  const p95Index = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * 0.95),
  );

  return {
    fps: 1000 / (total / samples),
    p95Ms: sorted[p95Index],
    samples,
  };
}
