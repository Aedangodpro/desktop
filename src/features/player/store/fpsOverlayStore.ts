import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface FpsOverlayState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

/**
 * Off by default: the overlay runs its own rAF loop, and a diagnostics HUD
 * should never be part of the default rendering path.
 */
export const useFpsOverlayStore = create<FpsOverlayState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "liner_fps_overlay",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);
