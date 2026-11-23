import {
  isWindowVisible,
  onWindowVisibilityChange,
} from "@/shared/utils/windowVisibility";

export type FrameDemand = "animate" | "poll" | "idle";
export type FrameTick = (now: number, elapsedMs: number) => FrameDemand;

const POLL_MS = 50;

export class FrameLoop {
  private rafId: number | null = null;
  private pollId: number | null = null;
  private lastFrame = 0;
  private active = true;
  private readonly stopWatchingVisibility: () => void;

  constructor(private readonly tick: FrameTick) {
    this.stopWatchingVisibility = onWindowVisibilityChange((visible) => {
      if (visible) this.poke();
    });
  }

  /**
   * Stops scheduling entirely while the canvas is off screen or display: none.
   * The document visibility check cannot see either of those.
   */
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (!active) {
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      if (this.pollId !== null) window.clearTimeout(this.pollId);
      this.rafId = null;
      this.pollId = null;
      return;
    }
    this.lastFrame = 0;
    this.poke();
  }

  poke() {
    if (!this.active) return;
    if (this.pollId !== null) {
      window.clearTimeout(this.pollId);
      this.pollId = null;
    }
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(this.onFrame);
  }

  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.pollId !== null) window.clearTimeout(this.pollId);
    this.rafId = null;
    this.pollId = null;
    this.stopWatchingVisibility();
  }

  private readonly onFrame = (now: number) => {
    this.rafId = null;
    if (!this.active || !isWindowVisible()) return;
    const elapsed =
      this.lastFrame === 0 ? 16 : Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    const demand = this.tick(now, elapsed);
    if (demand === "animate") {
      this.rafId = requestAnimationFrame(this.onFrame);
    } else if (demand === "poll") {
      this.pollId = window.setTimeout(() => {
        this.pollId = null;
        this.poke();
      }, POLL_MS);
    }
  };
}
