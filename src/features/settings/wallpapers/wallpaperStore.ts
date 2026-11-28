import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { applyWallpaperTokens } from "./wallpaperTokens";
import type { WallpaperPalette } from "./wallpaperPalette";
import { CUSTOM_WALLPAPER_ID } from "./wallpapers";

export type WallpaperTheme = "dark" | "light";

export interface WallpaperPalettes {
  dark?: WallpaperPalette;
  light?: WallpaperPalette;
}

export interface CustomWallpaper {
  /** re-encoded JPEG data URL, readable for palette sampling everywhere */
  dataUrl: string;
  name: string;
  updatedAt: number;
}

interface WallpaperState {
  selectedId: string | null;
  custom: CustomWallpaper | null;
  palettes: Record<string, WallpaperPalettes>;
  setSelectedId: (id: string | null) => void;
  setCustomWallpaper: (wallpaper: { dataUrl: string; name: string }) => void;
  clearCustomWallpaper: () => void;
  setPalette: (
    id: string,
    theme: WallpaperTheme,
    palette: WallpaperPalette,
  ) => void;
}

export const WALLPAPER_STORAGE_KEY = "liner_wallpaper";

export const useWallpaperStore = create<WallpaperState>()(
  persist(
    (set) => ({
      selectedId: null,
      custom: null,
      palettes: {},
      setSelectedId: (selectedId) => set({ selectedId }),
      setCustomWallpaper: ({ dataUrl, name }) =>
        set((state) => {
          // The image changed, so any palette read from the old one is stale.
          const palettes = { ...state.palettes };
          delete palettes[CUSTOM_WALLPAPER_ID];
          return {
            selectedId: CUSTOM_WALLPAPER_ID,
            custom: { dataUrl, name, updatedAt: Date.now() },
            palettes,
          };
        }),
      clearCustomWallpaper: () =>
        set((state) => {
          const palettes = { ...state.palettes };
          delete palettes[CUSTOM_WALLPAPER_ID];
          return {
            custom: null,
            palettes,
            selectedId:
              state.selectedId === CUSTOM_WALLPAPER_ID
                ? null
                : state.selectedId,
          };
        }),
      setPalette: (id, theme, palette) =>
        set((state) => ({
          palettes: {
            ...state.palettes,
            [id]: { ...state.palettes[id], [theme]: palette },
          },
        })),
    }),
    {
      name: WALLPAPER_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        selectedId: state.selectedId,
        custom: state.custom,
        palettes: state.palettes,
      }),
    },
  ),
);

export function currentWallpaperTheme(): WallpaperTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Runs from the entry point so the saved accent is already in place before the
 * first paint. Persisted palettes make this synchronous.
 */
export function applyStoredWallpaper(): void {
  if (typeof document === "undefined") return;
  const { selectedId, palettes } = useWallpaperStore.getState();
  if (!selectedId) return;
  const palette = palettes[selectedId]?.[currentWallpaperTheme()] ?? null;
  applyWallpaperTokens(selectedId, palette);
}
