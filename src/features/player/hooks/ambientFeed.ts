import {
  isWindowVisible,
  onWindowVisibilityChange,
} from "@/shared/utils/windowVisibility";
import { usePlayerStore } from "../store/playerStore";

const STATE_INTERVAL_MS = 250;
export const AMBIENT_FADE_MS = 700;

const isPlaying = () => usePlayerStore.getState().status === "playing";

export function playbackState() {
  return {
    playing: isPlaying(),
    positionMs: usePlayerStore.getState().positionMs,
  };
}

export interface AmbientFeed {
  /** Rerun the run/pause decision, e.g. after the layer went off screen. */
  refresh: () => void;
  stop: () => void;
}

export function startAmbientFeed(
  worker: Worker,
  isElementVisible: () => boolean = () => true,
): AmbientFeed {
  let running = true;
  let pauseTimer: number | undefined;

  const setRunning = (next: boolean) => {
    window.clearTimeout(pauseTimer);
    if (next === running) return;
    if (next) {
      running = true;
      worker.postMessage({ type: "resume" });
      return;
    }
    pauseTimer = window.setTimeout(() => {
      running = false;
      worker.postMessage({ type: "pause" });
    }, AMBIENT_FADE_MS);
  };
  const sync = () =>
    setRunning(isElementVisible() && isWindowVisible() && isPlaying());

  const sendState = () => {
    if (running) worker.postMessage({ type: "state", state: playbackState() });
  };

  if (!isElementVisible() || !isWindowVisible() || !isPlaying()) {
    running = false;
    worker.postMessage({ type: "pause" });
  }
  const stateTimer = window.setInterval(sendState, STATE_INTERVAL_MS);
  const stopWatchingVisibility = onWindowVisibilityChange(sync);
  const stopWatchingPlayer = usePlayerStore.subscribe((state, previous) => {
    if (state.status !== previous.status) sync();
  });

  return {
    refresh: sync,
    stop: () => {
      window.clearInterval(stateTimer);
      window.clearTimeout(pauseTimer);
      stopWatchingVisibility();
      stopWatchingPlayer();
    },
  };
}
