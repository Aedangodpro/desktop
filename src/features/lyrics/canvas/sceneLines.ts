import { drawInstrumental } from "./drawInstrumental";
import { drawLine } from "./drawLine";
import type { EdgeFog } from "./edgeFog";
import { BITMAP_PAD, type LineBitmaps } from "./lineBitmaps";
import type { LyricsScene } from "./lyricsScene";
import type { ScrollMotion } from "./scrollMotion";
import { isLineAnimating, lineExitMs } from "./timing";
import type { LineLayout } from "./types";

export interface SceneFrame {
  ctx: CanvasRenderingContext2D;
  scene: LyricsScene;
  motion: ScrollMotion;
  fog: EdgeFog;
  bitmaps: LineBitmaps;
  dpr: number;
  now: number;
  timeMs: number;
}

export interface VisibleLine {
  index: number;
  layout: LineLayout;
  top: number;
  key: string;
  live: boolean;
  fading: boolean;
  moving: boolean;
}

export function paintLine(frame: SceneFrame, layout: LineLayout) {
  const { scene, timeMs, dpr, now } = frame;
  return (ctx: CanvasRenderingContext2D, top: number) => {
    if (layout.line.instrumental) {
      drawInstrumental(
        ctx,
        layout,
        top,
        timeMs,
        scene.typography,
        scene.frame,
        dpr,
        now,
      );
      return;
    }
    drawLine(ctx, layout, top, timeMs, scene.typography, dpr, now);
  };
}

/**
 * How often a live (karaoke) line may be rasterised into a new bitmap. The
 * canvas still presents every display frame; only the text bitmap that carries
 * the sweep is rebuilt at most once per bucket. On a 200 Hz panel that is ~100
 * rasterisations per second instead of 200, and on a 60 Hz panel nothing
 * changes because every frame is already more than 8 ms apart. The sweep edge
 * moves well under a pixel in 8 ms, so the smaller cadence is not visible.
 */
export const LIVE_BITMAP_BUCKET_MS = 8;

export function liveBitmapKey(now: number, version: number): string {
  return `live:${version}:${Math.floor(now / LIVE_BITMAP_BUCKET_MS)}`;
}

function litState(layout: LineLayout, timeMs: number): string {
  if (timeMs >= lineExitMs(layout.line)) return "done";
  // Counting beats `tokens.filter(...).length`: the key is built for every
  // visible line on every frame, and the filter allocated an array each time.
  let lit = 0;
  for (const placed of layout.tokens) {
    if (placed.token.startMs <= timeMs) lit += 1;
  }
  return String(lit);
}

export function visibleLines(frame: SceneFrame): VisibleLine[] {
  const { scene, motion, now, timeMs, dpr } = frame;
  const lines: VisibleLine[] = [];
  scene.layouts.forEach((layout, index) => {
    const offset = motion.offsetFor(index, now);
    const exact = layout.top - motion.position + offset;
    const bottom = exact + layout.height + BITMAP_PAD;
    if (bottom < 0 || exact - BITMAP_PAD > scene.height) return;
    const live = isLineAnimating(layout.line, timeMs, now);
    const moving = offset !== 0 || motion.isWheelMoving();
    lines.push({
      index,
      layout,
      top: moving ? exact : Math.round(exact * dpr) / dpr,
      key: live
        ? liveBitmapKey(now, scene.version)
        : `still:${scene.version}:${litState(layout, timeMs)}`,
      live,
      fading: live && timeMs >= lineExitMs(layout.line),
      moving,
    });
  });
  return lines;
}

export function lineBitmap(frame: SceneFrame, line: VisibleLine) {
  return frame.bitmaps.get(
    line.index,
    line.key,
    frame.scene.width,
    line.layout.height,
    frame.dpr,
    paintLine(frame, line.layout),
  );
}
