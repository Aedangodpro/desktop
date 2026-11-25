import { useEffect, useState } from "react";
import { isWindowVisible } from "@/shared/utils/windowVisibility";

/**
 * The browser never reports the panel's refresh rate: there is no
 * `screen.refreshRate`. The only way to know is to watch rAF for a moment and
 * measure the interval between callbacks, which is what the balanced visual
 * mode needs so it can draw half of the display's cadence — 30 on a 60 Hz
 * panel, 100 on a 200 Hz one — instead of a hard-coded 30.
 */

export const FALLBACK_REFRESH_HZ = 60;

const COMMON_REFRESH_HZ = [60, 75, 90, 100, 120, 144, 165, 180, 200, 240, 360];
// Measured rates land slightly off the nominal value (59.94, 143.98), so a
// nearby common rate is the better answer. Anything further away is an unusual
// panel and is kept as measured rather than forced onto the list.
const SNAP_RATIO = 0.03;
const SAMPLE_MS = 500;
const MIN_SAMPLES = 8;
const MAX_FRAME_MS = 250;

export function snapRefreshRate(measuredHz: number): number {
  if (!Number.isFinite(measuredHz) || measuredHz <= 0) {
    return FALLBACK_REFRESH_HZ;
  }
  const nearest = COMMON_REFRESH_HZ.reduce((best, hz) =>
    Math.abs(hz - measuredHz) < Math.abs(best - measuredHz) ? hz : best,
  );
  const hz =
    Math.abs(nearest - measuredHz) / nearest <= SNAP_RATIO
      ? nearest
      : Math.round(measuredHz);
  return Math.min(500, Math.max(30, hz));
}

/**
 * The fastest sustained cadence in a sample, not the average: one long frame
 * (a decode, a layout, the tab waking up) would otherwise drag the estimate
 * down and halve the budget on a panel that was never slow.
 */
export function refreshRateFromDeltas(deltas: number[]): number {
  if (deltas.length < MIN_SAMPLES) return FALLBACK_REFRESH_HZ;
  const sorted = [...deltas].sort((a, b) => a - b);
  const frameMs = sorted[Math.floor(sorted.length * 0.1)];
  if (!(frameMs > 0)) return FALLBACK_REFRESH_HZ;
  return snapRefreshRate(1000 / frameMs);
}

/** Samples one rAF window and resolves the display's refresh rate. */
export function detectRefreshRate(
  sampleMs: number = SAMPLE_MS,
): Promise<number> {
  if (typeof window === "undefined" || !isWindowVisible()) {
    return Promise.resolve(FALLBACK_REFRESH_HZ);
  }
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let frameId = 0;
    let guard = 0;
    let last = 0;
    let settled = false;
    const started = performance.now();
    const finish = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frameId);
      window.clearTimeout(guard);
      resolve(refreshRateFromDeltas(deltas));
    };
    const measure = (now: number) => {
      if (last) {
        const delta = now - last;
        // rAF is throttled while the page is hidden, so a long delta is not a
        // slow panel; drop it rather than reading it as a low rate.
        if (delta > 0 && delta < MAX_FRAME_MS) deltas.push(delta);
      }
      last = now;
      if (now - started < sampleMs) {
        frameId = requestAnimationFrame(measure);
        return;
      }
      finish();
    };
    guard = window.setTimeout(finish, sampleMs * 4 + 500);
    frameId = requestAnimationFrame(measure);
  });
}

let cached: Promise<number> | null = null;

/**
 * One measurement per session: every surface that asks gets the same answer,
 * and a remount does not restart the sampler. A reading taken while the page
 * was hidden is not cached, so the next visible mount measures for real.
 */
export function displayRefreshRate(): Promise<number> {
  if (!cached) {
    cached = detectRefreshRate().then((hz) => {
      if (hz === FALLBACK_REFRESH_HZ && !isWindowVisible()) cached = null;
      return hz;
    });
  }
  return cached;
}

/** The detected display rate, or 60 until the first sample lands. */
export function useDisplayRefreshRate(): number {
  const [hz, setHz] = useState(FALLBACK_REFRESH_HZ);
  useEffect(() => {
    let cancelled = false;
    void displayRefreshRate().then((value) => {
      if (!cancelled) setHz(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return hz;
}
