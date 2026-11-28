import type { WallpaperPalette } from "./wallpaperPalette";

const PALETTE_TOKENS = [
  "--accent-primary",
  "--accent-secondary",
  "--accent-tertiary",
  "--wallpaper-tint",
  "--wallpaper-glow",
] as const;

/**
 * The palette lives on the document root rather than in React state so the
 * whole UI (accents, active states, the wallpaper layer) recolours at once,
 * and so a stored palette can be applied before the app mounts.
 */
export function applyWallpaperTokens(
  id: string | null,
  palette?: WallpaperPalette | null,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  if (!id) {
    root.removeAttribute("data-wallpaper");
    for (const token of PALETTE_TOKENS) root.style.removeProperty(token);
    return;
  }

  root.dataset.wallpaper = "on";
  if (!palette) return;

  root.style.setProperty("--accent-primary", palette.accent);
  root.style.setProperty("--accent-secondary", palette.accentSoft);
  root.style.setProperty("--accent-tertiary", palette.accentFaint);
  root.style.setProperty("--wallpaper-tint", palette.tint);
  root.style.setProperty("--wallpaper-glow", palette.glow);
}
