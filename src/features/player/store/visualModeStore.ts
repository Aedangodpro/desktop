import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { isSoftwareGpu, isWeakDevice } from "@/shared/lib";

export type VisualMode = "full" | "balanced" | "lite";

export const VISUAL_MODES: VisualMode[] = ["full", "balanced", "lite"];

const QUALITY: Record<VisualMode, number> = { full: 2, balanced: 1, lite: 0 };

export function visualModeRank(mode: VisualMode): number {
  return QUALITY[mode];
}

/** The next cheaper mode, or null when already at the cheapest. */
export function nextLowerMode(mode: VisualMode): VisualMode | null {
  const rank = QUALITY[mode];
  return (
    VISUAL_MODES.find((candidate) => QUALITY[candidate] === rank - 1) ?? null
  );
}

export interface VisualModeState {
  /** What the user picked; the only part that is persisted. */
  mode: VisualMode;
  /**
   * Session-only downgrade applied when frames are consistently late. It never
   * overrides the saved preference, and picking a mode clears it.
   */
  autoMode: VisualMode | null;
  ambientAvailable: boolean;
  setMode: (mode: VisualMode) => void;
  setAutoMode: (mode: VisualMode | null) => void;
  setAmbientAvailable: (available: boolean) => void;
}

export const useVisualModeStore = create<VisualModeState>()(
  persist(
    (set) => ({
      // Hardware that cannot composite the full effect stack starts one step
      // down instead of rendering in the single digits until the user digs
      // through the visuals picker. Software WebGL (SwiftShader, llvmpipe, a
      // blocklisted driver) is worse than "weak": the warp, the ambient canvas
      // and the lyrics all run on the CPU, so it starts at the cheapest mode.
      mode: isSoftwareGpu() ? "lite" : isWeakDevice() ? "balanced" : "full",
      autoMode: null,
      ambientAvailable: false,
      setMode: (mode) => set({ mode, autoMode: null }),
      setAutoMode: (autoMode) => set({ autoMode }),
      setAmbientAvailable: (ambientAvailable) => set({ ambientAvailable }),
    }),
    {
      name: "liner_visual_mode",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ mode: state.mode }),
    },
  ),
);

/** The mode used for rendering: an automatic downgrade always wins. */
export function effectiveVisualMode(
  state: Pick<VisualModeState, "mode" | "autoMode">,
): VisualMode {
  const auto = state.autoMode;
  return auto && visualModeRank(auto) < visualModeRank(state.mode)
    ? auto
    : state.mode;
}

export function useEffectiveVisualMode(): VisualMode {
  return useVisualModeStore(effectiveVisualMode);
}

export const useAmbientEnabled = () => useEffectiveVisualMode() !== "lite";

export const useLyricsEdgeFade = () => useEffectiveVisualMode() !== "lite";

export const useLyricsEdgeBlur = () => useEffectiveVisualMode() === "full";

export const useKawarpEnabled = () => useEffectiveVisualMode() !== "lite";

export const useGlassBlur = () => useEffectiveVisualMode() === "full";
