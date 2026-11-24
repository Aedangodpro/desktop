import { clamp01, fogEasing } from "./easing";

const FOG_TOP = 0.22;
const FOG_BOTTOM = 0.26;
const FOG_TRANSITION_MS = 450;
const FOG_STRIP_HEIGHT = 64;

interface FogTween {
  from: number;
  to: number;
  startedAt: number;
}

function tweenValue(tween: FogTween, now: number): number {
  const progress = clamp01((now - tween.startedAt) / FOG_TRANSITION_MS);
  return tween.from + (tween.to - tween.from) * fogEasing(progress);
}

/**
 * One-pixel columns of the edge fade, built once.
 *
 * The band is a gradient that changes height every frame while it tweens, so
 * `createLinearGradient` used to allocate a new gradient object and refill the
 * band on each of those frames. Stretching one cached strip is a single image
 * draw per band instead.
 */
const fogStrips: {
  fadeOut?: HTMLCanvasElement | null;
  fadeIn?: HTMLCanvasElement | null;
} = {};

function fogStrip(fadeIn: boolean): HTMLCanvasElement | null {
  const key = fadeIn ? "fadeIn" : "fadeOut";
  const cached = fogStrips[key];
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = FOG_STRIP_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    fogStrips[key] = null;
    return null;
  }
  const gradient = ctx.createLinearGradient(0, 0, 0, FOG_STRIP_HEIGHT);
  gradient.addColorStop(0, fadeIn ? "rgba(0, 0, 0, 0)" : "rgba(0, 0, 0, 1)");
  gradient.addColorStop(1, fadeIn ? "rgba(0, 0, 0, 1)" : "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1, FOG_STRIP_HEIGHT);
  fogStrips[key] = canvas;
  return canvas;
}

export class EdgeFog {
  enabled = true;
  private top: FogTween = { from: 0, to: 0, startedAt: 0 };
  private bottom: FogTween = { from: FOG_BOTTOM, to: FOG_BOTTOM, startedAt: 0 };

  private edges = "";

  track(atTop: boolean, atBottom: boolean, now: number): boolean {
    this.update(atTop, atBottom, now);
    const edges = `${atTop}:${atBottom}`;
    if (edges === this.edges) return false;
    this.edges = edges;
    return true;
  }

  update(atTop: boolean, atBottom: boolean, now: number) {
    this.top = this.retarget(this.top, atTop ? 0 : FOG_TOP, now);
    this.bottom = this.retarget(this.bottom, atBottom ? 0 : FOG_BOTTOM, now);
  }

  insets(height: number, now: number) {
    if (!this.enabled) return { top: 0, bottom: 0 };
    return {
      top: tweenValue(this.top, now) * height,
      bottom: tweenValue(this.bottom, now) * height,
    };
  }

  isMoving(now: number): boolean {
    return (
      now - this.top.startedAt < FOG_TRANSITION_MS ||
      now - this.bottom.startedAt < FOG_TRANSITION_MS
    );
  }

  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    now: number,
  ) {
    if (!this.enabled) return;
    const top = tweenValue(this.top, now) * height;
    const bottom = tweenValue(this.bottom, now) * height;
    if (top <= 0.5 && bottom <= 0.5) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    if (top > 0.5) {
      const strip = fogStrip(false);
      if (strip) ctx.drawImage(strip, 0, 0, width, top);
      else this.paintBand(ctx, width, 0, top, false);
    }
    if (bottom > 0.5) {
      const strip = fogStrip(true);
      if (strip) ctx.drawImage(strip, 0, height - bottom, width, bottom);
      else this.paintBand(ctx, width, height - bottom, bottom, true);
    }
    ctx.restore();
  }

  private paintBand(
    ctx: CanvasRenderingContext2D,
    width: number,
    y: number,
    bandHeight: number,
    fadeIn: boolean,
  ) {
    const gradient = ctx.createLinearGradient(0, y, 0, y + bandHeight);
    gradient.addColorStop(0, fadeIn ? "rgba(0, 0, 0, 0)" : "rgba(0, 0, 0, 1)");
    gradient.addColorStop(1, fadeIn ? "rgba(0, 0, 0, 1)" : "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, y, width, bandHeight);
  }

  private retarget(tween: FogTween, to: number, now: number): FogTween {
    if (tween.to === to) return tween;
    return { from: tweenValue(tween, now), to, startedAt: now };
  }
}
