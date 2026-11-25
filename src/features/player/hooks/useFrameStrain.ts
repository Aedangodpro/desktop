import { useEffect, useState } from "react";
import { isWindowVisible } from "@/shared/utils/windowVisibility";
import {
  FALLBACK_REFRESH_HZ,
  useDisplayRefreshRate,
} from "./useDisplayRefreshRate";

const SAMPLE_MS = 3000;
const PAUSE_MS = 10000;
const LATE_FACTOR = 1.8;
const LATE_SHARE = 0.2;
const STRIKES_TO_FLAG = 2;
// Below ~42fps the cadence itself is too slow, jitter or not.
const SLOW_MEDIAN_MS = 24;
// A late frame is measured against a 60 Hz budget at minimum. On a 200 Hz panel
// the fastest frames are ~5 ms apart, so 1.8x of *them* is 9 ms — an ordinary
// doubled refresh — and that used to read as a strained GPU and step the
// visuals down mid-song for no reason.
const MIN_BASELINE_MS = 1000 / 60;
// A steady cadence is compared with the display's own interval, not a fixed
// 60 Hz one: 1.5x the refresh is 25 ms at 60 Hz and 7.5 ms at 200 Hz. Without
// this a 200 Hz panel that settles at 80–120 fps has a healthy-looking median
// next to 24 ms and never steps the effects down, which is exactly the case
// that feels laggy.
const SLOW_MEDIAN_FACTOR = 1.5;

export function isStrained(
  deltas: number[],
  displayHz: number = FALLBACK_REFRESH_HZ,
): boolean {
  if (deltas.length < 30) return false;
  const sorted = [...deltas].sort((a, b) => a - b);
  const frame = sorted[Math.floor(sorted.length * 0.1)];
  const median = sorted[Math.floor(sorted.length * 0.5)];
  const baseline = Math.max(frame, MIN_BASELINE_MS);
  const refreshMs =
    1000 /
    (Number.isFinite(displayHz) && displayHz > 0
      ? displayHz
      : FALLBACK_REFRESH_HZ);
  const slowMedian = Math.min(SLOW_MEDIAN_MS, refreshMs * SLOW_MEDIAN_FACTOR);
  // A steady but slow cadence (every frame taking 50ms, say) has no late
  // frames relative to its own pace, so jitter alone never flags the devices
  // that most need the cheaper mode.
  if (median > slowMedian) return true;
  const late = deltas.filter((delta) => delta > baseline * LATE_FACTOR).length;
  return late / deltas.length > LATE_SHARE;
}

/**
 * Samples one window of frame deltas and resolves whether frames were late.
 * Used by the adaptive visual quality step-down; resolves false when the
 * document is hidden, because rAF stops there and would never settle.
 */
export function sampleFrameStrain(
  sampleMs: number = SAMPLE_MS,
  displayHz: number = FALLBACK_REFRESH_HZ,
): Promise<boolean> {
  if (typeof window === "undefined" || !isWindowVisible()) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let frameId = 0;
    let guard = 0;
    let last = 0;
    const deltas: number[] = [];
    const started = performance.now();
    const finish = (strained: boolean) => {
      cancelAnimationFrame(frameId);
      window.clearTimeout(guard);
      resolve(strained);
    };
    const measure = (now: number) => {
      if (last) deltas.push(now - last);
      last = now;
      if (now - started < sampleMs) {
        frameId = requestAnimationFrame(measure);
        return;
      }
      finish(isStrained(deltas, displayHz));
    };
    guard = window.setTimeout(() => finish(false), sampleMs * 3 + 500);
    frameId = requestAnimationFrame(measure);
  });
}

export function useFrameStrain(active: boolean): boolean {
  const [strained, setStrained] = useState(false);
  const displayHz = useDisplayRefreshRate();

  useEffect(() => {
    if (!active) return;
    let frameId = 0;
    let timer = 0;
    let strikes = 0;
    let deltas: number[] = [];
    let last = 0;
    let started = 0;

    const measure = (now: number) => {
      if (last) deltas.push(now - last);
      last = now;
      if (now - started < SAMPLE_MS) {
        frameId = requestAnimationFrame(measure);
        return;
      }
      strikes = isStrained(deltas, displayHz) ? strikes + 1 : 0;
      setStrained(strikes >= STRIKES_TO_FLAG);
      timer = window.setTimeout(begin, PAUSE_MS);
    };

    const begin = () => {
      if (!isWindowVisible()) {
        timer = window.setTimeout(begin, PAUSE_MS);
        return;
      }
      deltas = [];
      last = 0;
      started = performance.now();
      frameId = requestAnimationFrame(measure);
    };

    timer = window.setTimeout(begin, 2000);
    return () => {
      cancelAnimationFrame(frameId);
      window.clearTimeout(timer);
    };
  }, [active, displayHz]);

  return active && strained;
}
