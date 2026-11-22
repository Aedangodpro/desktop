import { useEffect } from "react";
import {
  effectiveVisualMode,
  nextLowerMode,
  useVisualModeStore,
} from "../store/visualModeStore";
import { sampleFrameStrain } from "./useFrameStrain";

const SETTLE_MS = 1500;
const STEP_COOLDOWN_MS = 4000;
// One slow window can be a track change or an image decode; require a run.
const STRAIN_WINDOWS = 2;

/**
 * Steps the visual effects down one level at a time while frames stay late, so
 * a screen that cannot composite the full stack recovers instead of sitting at
 * a handful of frames per second. Only the session downgrade changes: the
 * saved preference is untouched and picking a mode in the visuals picker wins.
 */
export function useAdaptiveVisuals(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer = 0;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, ms);
      });

    const run = async () => {
      let strikes = 0;
      while (!cancelled) {
        await wait(SETTLE_MS);
        if (cancelled) return;
        if (!(await sampleFrameStrain())) {
          strikes = 0;
          continue;
        }
        if (cancelled) return;
        strikes += 1;
        if (strikes < STRAIN_WINDOWS) continue;
        strikes = 0;
        const state = useVisualModeStore.getState();
        const next = nextLowerMode(effectiveVisualMode(state));
        // Already at the cheapest mode: stop sampling instead of spinning.
        if (!next) return;
        state.setAutoMode(next);
        await wait(STEP_COOLDOWN_MS);
      }
    };

    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active]);
}
