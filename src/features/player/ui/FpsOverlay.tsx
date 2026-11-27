import { useEffect, useState } from "react";
import { useDisplayRefreshRate } from "../hooks/useDisplayRefreshRate";
import { frameStats, type FrameStats } from "../lib/frameStats";
import { useFpsOverlayStore } from "../store/fpsOverlayStore";
import {
  useEffectiveVisualMode,
  useVisualModeStore,
} from "../store/visualModeStore";

const WINDOW_MS = 1000;
// Half-second publishes: the numbers are a diagnostic, not an animation, and
// each publish renders a component. Twice a second is plenty to see a stutter
// and half the render work of the old quarter-second cadence.
const PUBLISH_MS = 500;
// A gap this long is the tab waking up or the process being descheduled, not
// a frame the compositor missed; counting it would poison p95 for a second.
const MAX_FRAME_MS = 1000;

function FpsOverlayPanel() {
  const [stats, setStats] = useState<FrameStats | null>(null);
  const displayHz = useDisplayRefreshRate();
  const mode = useEffectiveVisualMode();
  const autoMode = useVisualModeStore((state) => state.autoMode);
  const downgraded = autoMode !== null && autoMode === mode;

  useEffect(() => {
    // A rolling window of frame times kept as plain numbers. Pushing one value
    // per frame and evicting by running sum keeps the sampler allocation-free:
    // the old version allocated an object per frame and an array per publish,
    // which is GC work on the very frame it is trying to measure.
    const deltas: number[] = [];
    let windowMs = 0;
    let frameId = 0;
    let last = 0;
    let publishedAt = 0;

    const measure = (now: number) => {
      if (last) {
        const delta = now - last;
        if (delta > 0 && delta < MAX_FRAME_MS) {
          deltas.push(delta);
          windowMs += delta;
        }
      }
      last = now;
      while (deltas.length > 2 && windowMs > WINDOW_MS) {
        windowMs -= deltas.shift()!;
      }
      if (now - publishedAt >= PUBLISH_MS) {
        publishedAt = now;
        setStats(frameStats(deltas));
      }
      frameId = requestAnimationFrame(measure);
    };

    // rAF does not run while hidden, so the first delta after waking would be
    // the whole hidden period. Start the window fresh instead.
    const onVisibilityChange = () => {
      deltas.length = 0;
      windowMs = 0;
      last = 0;
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    frameId = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const fps = stats ? Math.round(stats.fps) : null;
  const p95 = stats ? `${stats.p95Ms.toFixed(1)} ms` : "—";

  return (
    <div
      role="group"
      aria-label="Performance overlay"
      className="pointer-events-none fixed top-[66px] right-[18px] z-[75] w-[138px] select-none rounded-[8px] border border-white/10 bg-black/80 px-[9px] py-[7px] font-mono text-[10px] leading-[15px] text-white/55 shadow-[0_6px_18px_rgba(0,0,0,0.28)]"
    >
      <div className="grid grid-cols-[1fr_auto] gap-x-[8px] tabular-nums">
        <span>FPS</span>
        <span className="text-right font-[600] text-white/90">
          {fps ?? "—"}
        </span>
        <span>p95</span>
        <span className="text-right font-[600] text-white/90">{p95}</span>
        <span>Refresh</span>
        <span className="text-right font-[600] text-white/90">
          {displayHz} Hz
        </span>
        <span>Mode</span>
        <span className="text-right font-[600] text-white/90">
          {downgraded ? `${mode} · auto` : mode}
        </span>
      </div>
    </div>
  );
}

/** Opt-in diagnostics HUD; renders nothing until the setting is turned on. */
export function FpsOverlay() {
  const enabled = useFpsOverlayStore((state) => state.enabled);
  return enabled ? <FpsOverlayPanel /> : null;
}
