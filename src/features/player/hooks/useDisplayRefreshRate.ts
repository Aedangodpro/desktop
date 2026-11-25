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
// Several windows, not one: a sample taken while the page is still loading only
// ever reads slower than the panel, so the fastest window is the truthful one.
const SAMPLE_WINDOWS = 3;
const SAMPLE_GAP_MS = 120;
// A fallback reading gets one delayed retry and one on the next visible frame;
// a real 60 Hz panel just reads 60 again.
const RETRY_MS = 2500;
const MAX_REDETECTS = 2;
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
export function refreshRateFromDeltas(deltas: readonly number[]): number {
  if (deltas.length < MIN_SAMPLES) return FALLBACK_REFRESH_HZ;
  const sorted = [...deltas].sort((a, b) => a - b);
  const frameMs = sorted[Math.floor(sorted.length * 0.1)];
  if (!(frameMs > 0)) return FALLBACK_REFRESH_HZ;
  return snapRefreshRate(1000 / frameMs);
}

/**
 * The fastest cadence any window measured. Frames are only ever delivered late,
 * never early, so a window that ran while the tab was loading or throttled can
 * read 60 Hz on a 200 Hz panel; the best window is the honest answer.
 */
export function bestRefreshRate(
  windows: readonly (readonly number[])[],
): number {
  let best = FALLBACK_REFRESH_HZ;
  for (const deltas of windows) {
    best = Math.max(best, refreshRateFromDeltas(deltas));
  }
  return best;
}

/**
 * Samples several rAF windows, with a gap between them, and resolves the
 * fastest cadence seen. One window taken at mount used to be enough: on Chrome
 * that window ran while the app was still booting at 60 Hz and pinned a 200 Hz
 * panel to 60 for the whole session.
 */
export function detectRefreshRate(
  sampleMs: number = SAMPLE_MS,
  windows: number = SAMPLE_WINDOWS,
): Promise<number> {
  if (typeof window === "undefined" || !isWindowVisible()) {
    return Promise.resolve(FALLBACK_REFRESH_HZ);
  }
  return new Promise((resolve) => {
    const measured: number[][] = [];
    let current: number[] = [];
    let frameId = 0;
    let timer = 0;
    let guard = 0;
    let last = 0;
    let windowStarted = 0;
    let remaining = Math.max(1, Math.floor(windows));
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frameId);
      window.clearTimeout(timer);
      window.clearTimeout(guard);
      resolve(bestRefreshRate(measured));
    };

    const measure = (now: number) => {
      if (last) {
        const delta = now - last;
        // rAF is throttled while the page is hidden, so a long delta is not a
        // slow panel; drop it rather than reading it as a low rate.
        if (delta > 0 && delta < MAX_FRAME_MS) current.push(delta);
      }
      last = now;
      if (now - windowStarted < sampleMs) {
        frameId = requestAnimationFrame(measure);
        return;
      }
      measured.push(current);
      current = [];
      remaining -= 1;
      if (remaining <= 0) {
        finish();
        return;
      }
      last = 0;
      timer = window.setTimeout(startWindow, SAMPLE_GAP_MS);
    };

    const startWindow = () => {
      if (settled) return;
      // Hidden mid-measurement: the rest would only read the throttle, so keep
      // what the visible windows saw instead of waiting out the guard.
      if (!isWindowVisible()) {
        finish();
        return;
      }
      current = [];
      last = 0;
      windowStarted = performance.now();
      frameId = requestAnimationFrame(measure);
    };

    guard = window.setTimeout(
      finish,
      (sampleMs + SAMPLE_GAP_MS) * remaining + 2000,
    );
    startWindow();
  });
}

let cached: Promise<number> | null = null;
let lastValue: number | null = null;
let redetects = 0;

/**
 * One measurement per session: every surface that asks gets the same answer,
 * and a remount does not restart the sampler. A reading taken while the page
 * was hidden is not cached, so the next visible mount measures for real.
 */
export function displayRefreshRate(): Promise<number> {
  if (!cached) {
    cached = detectRefreshRate().then((hz) => {
      lastValue = hz;
      if (hz === FALLBACK_REFRESH_HZ && !isWindowVisible()) cached = null;
      return hz;
    });
  }
  return cached;
}

/**
 * Measures again after a fallback reading, bounded to a couple of attempts per
 * session. Chrome hands out 60 Hz rAF to a window that is still loading or not
 * focused yet and runs at the panel rate afterwards, so the first sample is the
 * one most likely to be wrong; a genuine 60 Hz panel simply reads 60 again.
 */
export function redetectRefreshRate(): Promise<number> {
  if (lastValue !== null && lastValue !== FALLBACK_REFRESH_HZ) {
    return Promise.resolve(lastValue);
  }
  if (redetects >= MAX_REDETECTS) {
    return Promise.resolve(lastValue ?? FALLBACK_REFRESH_HZ);
  }
  redetects += 1;
  cached = null;
  return displayRefreshRate();
}

/** The detected display rate, or 60 until the first sample lands. */
export function useDisplayRefreshRate(): number {
  const [hz, setHz] = useState(FALLBACK_REFRESH_HZ);
  useEffect(() => {
    let cancelled = false;
    let retryTimer = 0;
    const apply = (value: number) => {
      if (!cancelled) setHz(value);
    };
    void displayRefreshRate().then((value) => {
      apply(value);
      if (value !== FALLBACK_REFRESH_HZ || cancelled) return;
      // One retry once the app has settled. Nothing else would ever correct a
      // visible tab's first reading, which on Chrome is taken mid-boot at
      // 60 Hz and then never revisited.
      retryTimer = window.setTimeout(() => {
        void redetectRefreshRate().then(apply);
      }, RETRY_MS);
    });
    // A sample taken while the tab was hidden is just the throttle; use the
    // next visible frame to measure the panel for real.
    const onVisibilityChange = () => {
      if (document.hidden) return;
      void redetectRefreshRate().then(apply);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  return hz;
}
