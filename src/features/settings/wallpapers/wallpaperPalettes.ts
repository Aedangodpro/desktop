import {
  extractWallpaperPalette,
  neutralWallpaperPalette,
  type WallpaperPalette,
} from "./wallpaperPalette";
import { useWallpaperStore, type WallpaperTheme } from "./wallpaperStore";
import { WALLPAPER_SAMPLES } from "./wallpaperSamples";
import { CUSTOM_WALLPAPER_ID, findWallpaper } from "./wallpapers";

const pending = new Map<string, Promise<WallpaperPalette>>();

interface WallpaperSample {
  src: string;
  /** changes when the sampled image changes, so stale results can be skipped */
  stamp: string;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load wallpaper"));
    image.src = src;
  });
}

function wallpaperSample(id: string): WallpaperSample | null {
  if (id === CUSTOM_WALLPAPER_ID) {
    const custom = useWallpaperStore.getState().custom;
    return custom
      ? { src: custom.dataUrl, stamp: String(custom.updatedAt) }
      : null;
  }

  const wallpaper = findWallpaper(id);
  if (!wallpaper) return null;
  // sample the inlined copy so the canvas stays readable on file:// (Electron)
  return {
    src: WALLPAPER_SAMPLES[wallpaper.id] ?? wallpaper.src,
    stamp: wallpaper.id,
  };
}

/**
 * Return the palette for a wallpaper in a theme, sampling the image the first
 * time it is needed. Concurrent callers share one decode.
 */
export function ensureWallpaperPalette(
  id: string,
  theme: WallpaperTheme,
): Promise<WallpaperPalette> {
  const isDark = theme === "dark";
  const sample = wallpaperSample(id);
  if (!sample) return Promise.resolve(neutralWallpaperPalette(isDark));

  const cached = useWallpaperStore.getState().palettes[id]?.[theme];
  if (cached) return Promise.resolve(cached);

  const key = `${id}:${theme}:${sample.stamp}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const promise = loadImage(sample.src)
    .then((image) => extractWallpaperPalette(image, isDark))
    .catch(() => neutralWallpaperPalette(isDark))
    .then((palette) => {
      pending.delete(key);
      // A custom image can be replaced while it is being read; keep the old
      // result out of the store so the new image wins.
      if (wallpaperSample(id)?.stamp === sample.stamp) {
        useWallpaperStore.getState().setPalette(id, theme, palette);
      }
      return palette;
    });

  pending.set(key, promise);
  return promise;
}
