export {
  resolveLyrics,
  isWebLyricsProvider,
  lyricsProviders,
  type LyricsResolution,
} from "./resolveLyrics";
export {
  streamLyricsEvents,
  raceLyricsProviders,
  DEFAULT_GRACE_MS,
  type ProviderOutcome,
  type StreamLyricsOptions,
} from "./streamLyrics";
export { withTimeout, type ScopedSignal } from "./signal";
export {
  SYNC_DEPTH,
  buildQuality,
  compareCandidates,
  preferCandidate,
  isDecisiveCandidate,
  syncTier,
  type QualityInput,
} from "./ranking";
export { fetchLrcmuxLyrics, lrcmuxProvider } from "./lrcmuxLyrics";
export {
  fetchLrclibLyrics,
  lrclibProvider,
  cleanLyricsTitle,
} from "./lrclibLyrics";
export { fetchLyricsOvh, lyricsOvhProvider } from "./lyricsOvh";
export type { LyricsHint, LyricsProvider } from "./types";
