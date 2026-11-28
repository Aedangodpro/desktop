import { useEffect } from "react";
import { useEffectiveCoverGlow } from "../store/customizationStore";
import { ensureWallpaperPalette } from "../wallpapers/wallpaperPalettes";
import { useWallpaperStore } from "../wallpapers/wallpaperStore";
import { applyWallpaperTokens } from "../wallpapers/wallpaperTokens";

export function useWallpaperSync() {
  const selectedId = useWallpaperStore((state) => state.selectedId);
  // Replacing the picked image keeps the same id but brings a new palette.
  const customUpdatedAt = useWallpaperStore(
    (state) => state.custom?.updatedAt ?? 0,
  );
  const isDark = useEffectiveCoverGlow();

  useEffect(() => {
    if (!selectedId) {
      applyWallpaperTokens(null);
      return;
    }

    const theme = isDark ? "dark" : "light";
    const cached = useWallpaperStore.getState().palettes[selectedId]?.[theme];
    applyWallpaperTokens(selectedId, cached ?? null);
    if (cached) return;

    let active = true;
    void ensureWallpaperPalette(selectedId, theme).then((palette) => {
      if (active) applyWallpaperTokens(selectedId, palette);
    });
    return () => {
      active = false;
    };
  }, [selectedId, isDark, customUpdatedAt]);
}
