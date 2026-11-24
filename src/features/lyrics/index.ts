export {
  parseRawLyrics,
  applyLyricsOffset,
  type ParsedLyrics,
  type WordData,
} from "./engine/lyricsParser";
export {
  mergeSyllablesIntoWords,
  findActiveWordIndex,
  type TimedWord,
} from "./engine/wordGroups";
export {
  useLyricsStore,
  hasSyncedLyricsSources,
  type LyricsProviderOption,
} from "./store/lyricsStore";
export {
  lyricsCache,
  isLyricsCandidate,
  shouldCacheLyricsCandidate,
  isProvisionalLyricsCandidate,
  mergeLyricsProvider,
  compareLyricsCandidates,
  isBetterLyricsCandidate,
  isWordLevelSync,
  type CachedLyricsItem,
} from "./store/lyricsCache";
export {
  useLyricsAnimator,
  type LyricsWord,
  type SyncedLine,
} from "./hooks/useLyricsAnimator";
export { LyricsProviderIsland } from "./ui/LyricsProviderIsland";
export { LyricsSyncBadge } from "./ui/LyricsSyncBadge";
export {
  LyricsCanvasRenderer,
  type LyricsClock,
  type EdgesListener,
} from "./canvas/lyricsCanvasRenderer";
