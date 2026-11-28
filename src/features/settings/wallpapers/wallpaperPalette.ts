import { rgbToHsl } from "@/shared/lib/color";

export type WallpaperSwatches = [string, string, string];

export interface WallpaperPalette {
  /** vivid interface accent taken from the wallpaper */
  accent: string;
  accentSoft: string;
  accentFaint: string;
  /** wash laid over the wallpaper behind the app chrome */
  tint: string;
  /** second-hue light that glows from the top of the window */
  glow: string;
  /** three colours for the wallpaper's swatch strip */
  swatches: WallpaperSwatches;
}

const BUCKET_COUNT = 12;
const MIN_PIXEL_SATURATION = 0.1;
const MIN_COLOURED_SHARE = 0.08;
const SAMPLE_WIDTH = 72;
const SAMPLE_HEIGHT = 44;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const wrapHue = (hue: number) => ((hue % 1) + 1) % 1;

const hueDistance = (a: number, b: number) => {
  const diff = Math.abs(wrapHue(a) - wrapHue(b));
  return Math.min(diff, 1 - diff);
};

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${Math.round(wrapHue(hue) * 360)}, ${Math.round(
    clamp(saturation, 0, 1) * 100,
  )}%, ${Math.round(clamp(lightness, 0, 1) * 100)}%)`;
}

function hsla(
  hue: number,
  saturation: number,
  lightness: number,
  alpha: number,
): string {
  return `hsla(${Math.round(wrapHue(hue) * 360)}, ${Math.round(
    clamp(saturation, 0, 1) * 100,
  )}%, ${Math.round(clamp(lightness, 0, 1) * 100)}%, ${alpha.toFixed(2)})`;
}

/**
 * Saturated wallpapers get a punchy accent, but a wallpaper that is nearly
 * grey should stay quiet instead of being forced into a colour.
 */
function tuneSaturation(
  saturation: number,
  scale: number,
  min: number,
  max: number,
): number {
  if (saturation < 0.3) return clamp(saturation * scale, 0.06, 0.3);
  return clamp(saturation * scale, min, max);
}

function buildPalette(
  hue: number,
  saturation: number,
  secondaryHue: number,
  secondarySaturation: number,
  isDark: boolean,
): WallpaperPalette {
  if (isDark) {
    const accent = hsl(hue, tuneSaturation(saturation, 1.2, 0.45, 0.9), 0.63);
    return {
      accent,
      accentSoft: hsl(hue, tuneSaturation(saturation, 1.05, 0.4, 0.82), 0.75),
      accentFaint: hsl(hue, tuneSaturation(saturation, 1, 0.35, 0.75), 0.84),
      tint: hsla(hue, tuneSaturation(saturation, 0.8, 0.28, 0.66), 0.07, 0.45),
      glow: hsla(
        secondaryHue,
        tuneSaturation(secondarySaturation, 1, 0.35, 0.85),
        0.48,
        0.3,
      ),
      swatches: [
        hsl(hue, tuneSaturation(saturation, 1, 0.3, 0.7), 0.16),
        hsl(
          secondaryHue,
          tuneSaturation(secondarySaturation, 1, 0.35, 0.8),
          0.44,
        ),
        accent,
      ],
    };
  }

  const accent = hsl(hue, tuneSaturation(saturation, 1.15, 0.45, 0.88), 0.45);
  return {
    accent,
    accentSoft: hsl(hue, tuneSaturation(saturation, 1, 0.4, 0.8), 0.58),
    accentFaint: hsl(hue, tuneSaturation(saturation, 1, 0.35, 0.75), 0.7),
    tint: hsla(hue, tuneSaturation(saturation, 0.8, 0.3, 0.72), 0.89, 0.6),
    glow: hsla(
      secondaryHue,
      tuneSaturation(secondarySaturation, 1, 0.3, 0.75),
      0.84,
      0.35,
    ),
    swatches: [
      hsl(hue, tuneSaturation(saturation, 1, 0.3, 0.7), 0.88),
      hsl(
        secondaryHue,
        tuneSaturation(secondarySaturation, 1, 0.3, 0.75),
        0.68,
      ),
      accent,
    ],
  };
}

/** Quiet slate palette used when a wallpaper has no usable colour. */
export function neutralWallpaperPalette(isDark: boolean): WallpaperPalette {
  return buildPalette(0.58, 0.18, 0.62, 0.14, isDark);
}

interface HueBucket {
  weight: number;
  pixels: number;
  hueSum: number;
  saturationSum: number;
}

/**
 * Turn sampled RGBA pixels into a palette. Pure so it can be tested without a
 * canvas, and cheap: the caller hands it a downscaled thumbnail.
 */
export function paletteFromPixels(
  pixels: ArrayLike<number>,
  isDark: boolean,
): WallpaperPalette {
  const buckets: HueBucket[] = Array.from({ length: BUCKET_COUNT }, () => ({
    weight: 0,
    pixels: 0,
    hueSum: 0,
    saturationSum: 0,
  }));

  let total = 0;
  let coloured = 0;
  let hueSum = 0;
  let saturationSum = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 0) < 128) continue;
    const red = pixels[i] ?? 0;
    const green = pixels[i + 1] ?? 0;
    const blue = pixels[i + 2] ?? 0;
    total++;

    const [hue, saturation, lightness] = rgbToHsl(red, green, blue);
    hueSum += hue;
    saturationSum += saturation;

    if (lightness < 0.04 || lightness > 0.96) continue;
    if (saturation < MIN_PIXEL_SATURATION) continue;

    const index = Math.min(
      BUCKET_COUNT - 1,
      Math.floor(wrapHue(hue) * BUCKET_COUNT),
    );
    const bucket = buckets[index]!;
    bucket.weight += saturation * (1 - Math.abs(lightness - 0.5) * 0.7);
    bucket.pixels++;
    bucket.hueSum += hue;
    bucket.saturationSum += saturation;
    coloured++;
  }

  if (total === 0) return neutralWallpaperPalette(isDark);

  // A near-grey photo still deserves a palette: keep its hue, but quiet.
  if (coloured / total < MIN_COLOURED_SHARE) {
    const hue = hueSum / total;
    const saturation = clamp(saturationSum / total, 0.1, 0.3);
    return buildPalette(
      hue,
      saturation,
      wrapHue(hue + 0.06),
      saturation,
      isDark,
    );
  }

  const ranked = buckets
    .filter((bucket) => bucket.pixels > 0)
    .sort((a, b) => b.weight - a.weight);
  const best = ranked[0]!;
  const primaryHue = best.hueSum / best.pixels;
  const primarySaturation = clamp(best.saturationSum / best.pixels, 0.28, 0.9);

  const secondary = ranked.find((bucket) => {
    if (bucket === best) return false;
    const hue = bucket.hueSum / bucket.pixels;
    return (
      hueDistance(hue, primaryHue) > 0.08 && bucket.weight > best.weight * 0.12
    );
  });
  const secondaryHue = secondary
    ? secondary.hueSum / secondary.pixels
    : wrapHue(primaryHue + 0.08);
  const secondarySaturation = secondary
    ? clamp(secondary.saturationSum / secondary.pixels, 0.3, 0.9)
    : primarySaturation;

  return buildPalette(
    primaryHue,
    primarySaturation,
    secondaryHue,
    secondarySaturation,
    isDark,
  );
}

/** Draw the wallpaper once at thumbnail size and read its colours back. */
export function extractWallpaperPalette(
  image: HTMLImageElement,
  isDark: boolean,
): WallpaperPalette {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return neutralWallpaperPalette(isDark);
    context.drawImage(image, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    return paletteFromPixels(data, isDark);
  } catch {
    return neutralWallpaperPalette(isDark);
  }
}
