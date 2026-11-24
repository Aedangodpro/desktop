import type { TokenHighlight } from "./timing";
import type { PlacedToken } from "./types";

export interface TokenPaint {
  ctx: CanvasRenderingContext2D;
  top: number;
  rtl: boolean;
  base: number;
  remPx: number;
  dpr: number;
}

// Alpha is quantised to a byte and interned, so a line of text that is redrawn
// every frame stops producing a new `rgba(...)` string per token per frame.
const WHITE_STEPS = 256;
const whiteByAlpha: (string | undefined)[] = [];

export function white(alpha: number): string {
  const clamped = alpha > 0 ? (alpha < 1 ? alpha : 1) : 0;
  const index = Math.round(clamped * (WHITE_STEPS - 1));
  const cached = whiteByAlpha[index];
  if (cached !== undefined) return cached;
  const value = `rgba(255, 255, 255, ${(index / (WHITE_STEPS - 1)).toFixed(3)})`;
  whiteByAlpha[index] = value;
  return value;
}

function highlightStyle(
  paint: TokenPaint,
  placed: PlacedToken,
  highlight: TokenHighlight,
): string | CanvasGradient {
  if (highlight.solid >= 1) return white(highlight.opacity);
  const width = Math.max(1, placed.width);
  const start = paint.rtl ? placed.x + width : placed.x;
  const end = paint.rtl ? placed.x : placed.x + width;
  const y = paint.top + placed.baseline;
  const gradient = paint.ctx.createLinearGradient(start, y, end, y);
  const solid = highlight.solid;
  const clear = highlight.clear + 1 / width;
  const alphaAt = (offset: number) =>
    highlight.opacity *
    Math.max(0, Math.min(1, (clear - offset) / Math.max(1e-6, clear - solid)));
  gradient.addColorStop(0, white(alphaAt(0)));
  if (solid > 0 && solid < 1)
    gradient.addColorStop(solid, white(alphaAt(solid)));
  if (clear > 0 && clear < 1) gradient.addColorStop(clear, white(0));
  gradient.addColorStop(1, white(alphaAt(1)));
  return gradient;
}

export function drawToken(
  paint: TokenPaint,
  placed: PlacedToken,
  highlight: TokenHighlight | null,
) {
  const { ctx } = paint;
  const y = Math.round((paint.top + placed.baseline) * paint.dpr) / paint.dpr;
  const text = placed.token.text;
  // A token that has been swept completely is painted edge to edge by its
  // highlight, so the muted base pass underneath it is never visible. Skipping
  // it removes one text draw for every word that has already been sung, which
  // is most of the line while a track plays.
  const covered =
    highlight !== null &&
    highlight.solid >= 1 &&
    highlight.clear >= 1 &&
    highlight.opacity >= 1;
  if (!covered) {
    ctx.fillStyle = white(paint.base);
    ctx.fillText(text, placed.x, y);
  }
  if (!highlight || highlight.opacity <= 0) return;
  if (highlight.clear <= 0) return;
  ctx.fillStyle = highlightStyle(paint, placed, highlight);
  if (highlight.glowRem > 0) {
    ctx.save();
    ctx.shadowColor = white(1);
    ctx.shadowBlur = highlight.glowRem * paint.remPx * paint.dpr;
    ctx.fillText(text, placed.x, y);
    ctx.restore();
    return;
  }
  ctx.fillText(text, placed.x, y);
}
