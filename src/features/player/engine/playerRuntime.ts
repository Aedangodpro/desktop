import { usePlayerStore } from "../store/playerStore";
import { ApiError } from "@/shared/api";
import { log } from "@/shared/utils/logger";
import { telemetry } from "@/shared/telemetry";
import { linerDb, audioCache } from "@/shared/storage";
import { isStandaloneAudioFile } from "@/shared/storage/audioFormat";
import type { Track } from "@/shared/types";
import { markLinerStreamFailed } from "@/shared/media/liner/linerPlayback";
import { isLocalTrackId } from "@/shared/media/local";
import { IS_WEB_TARGET } from "@/shared/config/runtimeTarget";
import { isSavedTrack } from "@/shared/media/saved";
import { pitchShifter } from "./pitchShifter";
import { FLAT_EQ, isEqActive } from "./equalizer";
import { resolvePlaybackStream, type PlaybackStream } from "./streamResolver";
import { applyMediaSeek, type MediaSeekOptions } from "./seek";
import { logNowPlaying } from "./nowPlayingLog";
import {
  downloadAudioBytes,
  isBotCheckError,
  isYoutubeSignInDeclined,
  isYoutubeSignedIn,
  prefersSignInPrompt,
  requestYoutubeSignIn,
} from "@/shared/youtube";

// error recovery tuning (see the audio "error" handler)
const RECOVERY_HOLD_MS = 3000;
const WAITING_GRACE_MS = 300; // a buffering hiccup shorter than this never shows // must play this far past a recovery before it may retry again
/** how long an attached source may take to actually start before it is dead */
const START_TIMEOUT_MS = 15_000;
/** metadata is all a resume needs before playing; it arrives long before canplay */
const METADATA_TIMEOUT_MS = 1500;
/**
 * A source that stalls and never recovers used to leave the spinner up for
 * good: `waiting` fires, `play()` has already resolved, and nothing else is
 * scheduled. One reload at the stall position is tried, then the track is
 * reported so the engine can move on instead of hanging.
 */
const STALL_RECOVERY_MS = 12_000;
/**
 * IndexedDB can leave a read unsettled (an open blocked by another tab holding
 * an older database version, or a transaction stuck behind a large write). The
 * cache is an optimization, so a read that misses this deadline must not hold
 * up the stream: fall through to resolving one.
 */
const CACHE_LOOKUP_TIMEOUT_MS = 2_000;
/** events that can change how much of the current track is buffered */
const AUDIO_BUFFER_EVENTS = [
  "progress",
  "canplaythrough",
  "ended",
  "emptied",
] as const;

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    promise.then(finish, () => finish(null));
  });
}

/**
 * A source that never starts playing (as opposed to one that fails to resolve):
 * `play()` stayed pending past the deadline, or the element rejected the media
 * it was handed. Both are worth one clean reload instead of skipping the song.
 */
class PlaybackStartTimeout extends Error {
  constructor() {
    super(`Playback did not start within ${START_TIMEOUT_MS} ms`);
    this.name = "PlaybackStartTimeout";
  }
}

function isStartFailure(error: unknown): boolean {
  if (error instanceof PlaybackStartTimeout) return true;
  if (typeof DOMException === "undefined" || !(error instanceof DOMException))
    return false;
  return (
    error.name === "NotSupportedError" || error.name === "NotReadableError"
  );
}

export class PlayerRuntime {
  private audio: HTMLAudioElement;
  private currentTrackId: string | null = null;
  private loadEpoch = 0;
  // the track whose load is actually running, and its promise. Separate from
  // currentTrackId because that is set before the stream is ready and stays set
  // after a load fails; this pair is what deduplicates concurrent selections.
  private loadingTrackId: string | null = null;
  private currentLoadPromise: Promise<void> | null = null;
  private loadAbortController: AbortController | null = null;
  private isResetting = false;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private stallStartTime: number | null = null;
  private loadStartTime = 0;
  private ttfbMs = 0;
  private activePlayPromise: Promise<void> | null = null;
  private activeBlobUrl: string | null = null;
  private releaseActiveStream: (() => void) | null = null;
  // track whose audio is attached to the element right now. During a skip the old
  // source stays attached (paused) until the next one is ready, so this can lag
  // currentTrackId for a moment.
  private attachedTrackId: string | null = null;
  // the attached source is a presigned r2 url (not a blob, not youtube)
  private attachedFromLiner = false;
  private preloadingTrackId: string | null = null;
  private preloadingPromise: Promise<void> | null = null;
  private preloadAbortController: AbortController | null = null;
  private backgroundCacheAbortController: AbortController | null = null;
  private currentSessionExpiresAt: number | null = null;
  private recoveryAttempts = 0;
  // after a recovery, the retry budget only refills once playback gets past this
  // position: a "playing" event alone is not proof (a bad frame further on would
  // otherwise error -> recover -> play -> error forever, reloading every time)
  private recoveryHoldUntilMs: number | null = null;
  // a "waiting" only becomes the loading state if it lasts: a seek inside an already
  // loaded / cached track fires waiting -> playing within milliseconds, and flipping
  // the status for that re-animated the play / pause button on every seek
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;
  // deadline for a source that stays stuck after `waiting`; see recoverFromStall
  private stallWatchdog: ReturnType<typeof setTimeout> | null = null;
  public onEnded?: () => void;
  public onError?: (info: { trackId: string; message: string }) => void;

  constructor() {
    const win = typeof window !== "undefined" ? (window as any) : null;
    let audio = (win?.__liner_audio ||
      (typeof document !== "undefined" &&
        document.getElementById("liner-audio"))) as HTMLAudioElement | null;
    if (!audio) {
      audio = new Audio();
      audio.id = "liner-audio";
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";
      if (typeof document !== "undefined") {
        document.body.appendChild(audio);
      }
    }
    if (win) {
      win.__liner_audio = audio;
    }
    this.audio = audio;
    this.setupAudioListeners(this.audio);

    const initialVolume = usePlayerStore.getState().volume;
    this.audio.volume = initialVolume;
    this.applyPlaybackRateAndPitch();
    log("cyan", "boot", `volume ${initialVolume}`);

    usePlayerStore.subscribe((state, prevState) => {
      if (state.status !== prevState.status) {
        this.syncMediaSessionState(state.status);
      }
      if (state.volume !== prevState.volume) {
        this.cancelFade();
        if (!this.audio.paused) {
          this.audio.volume = state.volume;
        }
      }
      if (
        state.playbackRate !== prevState.playbackRate ||
        state.isPitchLinked !== prevState.isPitchLinked ||
        state.pitchSemitones !== prevState.pitchSemitones ||
        state.isReverbEnabled !== prevState.isReverbEnabled ||
        state.reverbLevel !== prevState.reverbLevel ||
        state.isEqEnabled !== prevState.isEqEnabled ||
        state.eqGains !== prevState.eqGains
      ) {
        const rate = state.playbackRate ?? 1;
        const preservesPitch = !state.isPitchLinked;
        this.applyPlaybackRateAndPitch(rate, preservesPitch);
      }
    });

    this.setupDeviceChangeListener();
    this.setupMediaSession();
    log("green", "boot", "player runtime initialized");
  }

  private setupDeviceChangeListener() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

    let initial = true;
    const onDeviceChange = () => {
      if (initial) {
        initial = false;
        return;
      }
      if (!usePlayerStore.getState().pauseOnDeviceChange) return;
      if (
        !this.audio.paused &&
        usePlayerStore.getState().status === "playing"
      ) {
        this.pause();
      }
    };

    try {
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
      void navigator.mediaDevices.enumerateDevices().then(() => {
        initial = false;
      });
    } catch {
      // ignore unsupported environments
    }
  }

  private setupMediaSession() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;

    try {
      navigator.mediaSession.setActionHandler("play", () => {
        usePlayerStore.getState().dispatch({ type: "RESUME_REQUESTED" });
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        usePlayerStore.getState().dispatch({ type: "SKIP_PREVIOUS" });
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        usePlayerStore.getState().dispatch({ type: "SKIP_NEXT" });
      });
      navigator.mediaSession.setActionHandler("stop", () => {
        usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });
      });
      const seekBy = (deltaSeconds: number) => {
        const st = usePlayerStore.getState();
        const max =
          st.durationMs > 0 ? st.durationMs : Number.POSITIVE_INFINITY;
        const next = Math.min(
          max,
          Math.max(0, st.positionMs + deltaSeconds * 1000),
        );
        st.dispatch({ type: "SEEK_COMMITTED", positionMs: Math.round(next) });
      };
      navigator.mediaSession.setActionHandler("seekbackward", (details) => {
        seekBy(-(details.seekOffset ?? 10));
      });
      navigator.mediaSession.setActionHandler("seekforward", (details) => {
        seekBy(details.seekOffset ?? 10);
      });
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.seekTime !== undefined && !Number.isNaN(details.seekTime)) {
          usePlayerStore.getState().dispatch({
            type: "SEEK_COMMITTED",
            positionMs: Math.round(details.seekTime * 1000),
          });
        }
      });
    } catch {
      // ignore unsupported media session actions
    }
  }

  // windows' media controls (and apps built on them, like FluentFlyout) read this.
  // "loading" between tracks still reports playing so the session never looks finished.
  private syncMediaSessionState(status: string) {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    try {
      navigator.mediaSession.playbackState =
        status === "playing" || status === "loading"
          ? "playing"
          : status === "paused"
            ? "paused"
            : "none";
      if (status === "idle") navigator.mediaSession.metadata = null;
    } catch {
      // ignore unsupported environments
    }
  }

  // progress / seek bar in the system controls
  private syncMediaSessionPosition() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    const ms = navigator.mediaSession as MediaSession & {
      setPositionState?: (state?: MediaPositionState) => void;
    };
    if (typeof ms.setPositionState !== "function") return;
    if (this.attachedTrackId !== this.currentTrackId) return;
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      ms.setPositionState({
        duration,
        playbackRate: this.audio.playbackRate > 0 ? this.audio.playbackRate : 1,
        position: Math.min(duration, Math.max(0, this.audio.currentTime || 0)),
      });
    } catch {
      // ignore invalid transient states
    }
  }

  public updateMediaSessionMetadata(track: Track | null) {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artists,
        album: (track as { albumTitle?: string }).albumTitle || "Liner",
        artwork: track.coverUrl
          ? [
              { src: track.coverUrl, sizes: "96x96", type: "image/jpeg" },
              { src: track.coverUrl, sizes: "256x256", type: "image/jpeg" },
              { src: track.coverUrl, sizes: "512x512", type: "image/jpeg" },
            ]
          : [],
      });
    } catch {
      // ignore metadata assignment failures
    }
  }

  private setupAudioListeners(audioEl: HTMLAudioElement) {
    audioEl.addEventListener("timeupdate", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId) return;
      if (usePlayerStore.getState().status === "loading") return;
      if (Number.isNaN(audioEl.currentTime)) return;

      const posMs = Math.round(audioEl.currentTime * 1000);
      usePlayerStore.getState().setPosition(posMs);
      if (
        this.recoveryHoldUntilMs !== null &&
        posMs >= this.recoveryHoldUntilMs
      ) {
        this.recoveryHoldUntilMs = null;
        this.recoveryAttempts = 0;
      }
    });

    audioEl.addEventListener("durationchange", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId) return;
      if (Number.isNaN(audioEl.duration) || audioEl.duration <= 0) return;

      usePlayerStore
        .getState()
        .setDuration(Math.round(audioEl.duration * 1000));
      this.syncMediaSessionPosition();
    });

    for (const type of [
      "seeked",
      "ratechange",
      "play",
      "pause",
      "loadedmetadata",
    ]) {
      audioEl.addEventListener(type, () => {
        if (this.isResetting || audioEl !== this.audio) return;
        this.syncMediaSessionPosition();
      });
    }

    audioEl.addEventListener("waiting", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      log("yellow", "audio", "buffering (waiting)");
      this.stallStartTime = performance.now();
      this.watchForStall();
      if (this.waitingTimer) clearTimeout(this.waitingTimer);
      this.waitingTimer = setTimeout(() => {
        this.waitingTimer = null;
        // still stuck: a real stall, show it
        if (audioEl !== this.audio || audioEl.paused || audioEl.readyState >= 3)
          return;
        if (usePlayerStore.getState().status === "playing") {
          usePlayerStore.getState().setStatus("loading");
        }
      }, WAITING_GRACE_MS);
    });

    // resumed (or never really stalled): drop a pending "loading"
    for (const type of ["playing", "seeked", "canplay", "pause", "emptied"]) {
      audioEl.addEventListener(type, () => {
        if (audioEl !== this.audio) return;
        this.clearStallWatchdog();
        if (!this.waitingTimer) return;
        if (type === "seeked" && audioEl.readyState < 3) return; // seeked but still no data
        clearTimeout(this.waitingTimer);
        this.waitingTimer = null;
      });
    }

    audioEl.addEventListener("ended", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      this.clearStallWatchdog();
      if (!this.currentTrackId) return;
      if (this.attachedTrackId !== this.currentTrackId) return;

      // Ensure the track truly finished playing (not an empty media load or teardown artefact)
      const duration = audioEl.duration;
      const currentTime = audioEl.currentTime;
      if (duration > 0 && currentTime >= Math.max(0, duration - 1.5)) {
        log("cyan", "audio", "ended — skipping to next");
        this.onEnded?.();
        const state = usePlayerStore.getState();
        state.dispatch({ type: "SKIP_NEXT", isAutoEnd: true });
      }
    });

    audioEl.addEventListener("playing", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      this.clearStallWatchdog();
      log("green", "audio", "playing");
      if (this.recoveryHoldUntilMs === null) this.recoveryAttempts = 0;
      this.applyPlaybackRateAndPitch();

      if (this.stallStartTime !== null) {
        const stallDurationMs = Math.round(
          performance.now() - this.stallStartTime,
        );
        if (stallDurationMs > 400) {
          telemetry.trackPlaybackHealth("STALL_BUFFERING", {
            trackId: this.currentTrackId || undefined,
            stallDurationMs,
          });
        }
        this.stallStartTime = null;
      }

      if (!this.currentTrackId || audioEl.paused) return;
      const currentStatus = usePlayerStore.getState().status;
      if (currentStatus !== "paused") {
        usePlayerStore.getState().setStatus("playing");
      }
    });

    audioEl.addEventListener("pause", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      this.clearStallWatchdog();
      log("cyan", "audio", "paused");
      const st = usePlayerStore.getState().status;
      if (st === "playing") {
        usePlayerStore.getState().setStatus("paused");
      }
    });

    audioEl.addEventListener("error", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (
        !this.currentTrackId ||
        !audioEl.src ||
        audioEl.src === window.location.href
      )
        return;
      // the previous track's source is still attached while the next one loads
      if (this.attachedTrackId !== this.currentTrackId) return;

      this.clearStallWatchdog();
      const message = audioEl.error?.message || "Audio playback error";
      const code = audioEl.error?.code;
      console.error(
        "[AudioElementError]",
        this.currentTrackId,
        code,
        message,
        audioEl.src,
      );
      log("red", "audio", `error (code ${code}): ${message}`);

      const isDecode =
        code ===
          (typeof MediaError !== "undefined"
            ? MediaError.MEDIA_ERR_DECODE
            : 3) ||
        code ===
          (typeof MediaError !== "undefined"
            ? MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            : 4);

      if (isDecode) {
        telemetry.trackPlaybackHealth("MEDIA_DECODE_ERROR", {
          trackId: this.currentTrackId || undefined,
          errorMessage: message,
          details: { mediaErrorCode: code },
        });
      }

      if (this.attachedFromLiner) {
        this.attachedFromLiner = false;
        markLinerStreamFailed(`media error ${code}`);
      }

      if (this.activeBlobUrl) {
        URL.revokeObjectURL(this.activeBlobUrl);
        this.activeBlobUrl = null;
        void linerDb.deleteAudio(this.currentTrackId);
        audioCache.deleteAudio(this.currentTrackId);
      }

      const store = usePlayerStore.getState();
      const currentTrack = store.currentTrack;
      const posMs =
        Number.isFinite(audioEl.currentTime) && audioEl.currentTime > 0
          ? Math.round(audioEl.currentTime * 1000)
          : store.positionMs;

      if (
        currentTrack &&
        currentTrack.id === this.currentTrackId &&
        this.recoveryAttempts < 1
      ) {
        this.recoveryAttempts++;
        this.recoveryHoldUntilMs = posMs + RECOVERY_HOLD_MS;
        log(
          "yellow",
          "playback",
          `audio error encountered — recovering via cache/stream at ${posMs}ms`,
        );
        void this.loadAndPlay(currentTrack, posMs, true);
        return;
      }

      usePlayerStore.getState().setStatus("error", message);
      this.onError?.({ trackId: this.currentTrackId, message });
    });
  }

  private clearStallWatchdog(): void {
    if (this.stallWatchdog === null) return;
    clearTimeout(this.stallWatchdog);
    this.stallWatchdog = null;
  }

  /** Arms the stall deadline for the track attached right now. */
  private watchForStall(): void {
    this.clearStallWatchdog();
    const trackId = this.currentTrackId;
    if (!trackId) return;
    this.stallWatchdog = setTimeout(() => {
      this.stallWatchdog = null;
      this.recoverFromStall();
    }, STALL_RECOVERY_MS);
  }

  private recoverFromStall(): void {
    const trackId = this.currentTrackId;
    if (!trackId || this.attachedTrackId !== trackId) return;
    const state = usePlayerStore.getState();
    if (state.status !== "loading" && state.status !== "playing") return;
    // Data arrived while the deadline was pending: the stall resolved itself.
    if (this.audio.readyState >= 3 && !this.audio.paused) return;
    const track = state.currentTrack;
    if (!track || track.id !== trackId) return;

    const posMs =
      Number.isFinite(this.audio.currentTime) && this.audio.currentTime > 0
        ? Math.round(this.audio.currentTime * 1000)
        : state.positionMs;

    if (this.recoveryAttempts < 1) {
      this.recoveryAttempts += 1;
      this.recoveryHoldUntilMs = posMs + RECOVERY_HOLD_MS;
      log(
        "yellow",
        "playback",
        `"${track.title}" stalled for ${STALL_RECOVERY_MS} ms — reloading once at ${posMs}ms`,
      );
      void this.loadAndPlay(track, posMs, true);
      return;
    }

    log("red", "audio", `"${track.title}" stalled with no recovery left`);
    usePlayerStore.getState().setStatus("error", "Playback stalled");
    this.onError?.({ trackId, message: "Playback stalled" });
  }

  public getCurrentTrackId(): string | null {
    return this.currentTrackId;
  }

  public isLoadInFlightFor(trackId: string): boolean {
    return this.loadingTrackId === trackId && this.currentLoadPromise !== null;
  }

  public hasLoadedSourceFor(trackId: string): boolean {
    const isExpired =
      this.currentSessionExpiresAt !== null &&
      Date.now() >= this.currentSessionExpiresAt - 15_000;
    return (
      this.currentTrackId === trackId &&
      this.attachedTrackId === trackId &&
      Boolean(this.audio.currentSrc || this.audio.src) &&
      this.audio.src !== window.location.href &&
      !this.audio.error &&
      !isExpired
    );
  }

  public applyPlaybackRateAndPitch(
    rate?: number,
    preservesPitch?: boolean,
  ): void {
    if (!this.audio) return;
    const store = usePlayerStore.getState();
    const targetRate = rate ?? store.playbackRate ?? 1;
    const targetPreserves =
      preservesPitch ??
      (store.isPitchLinked !== undefined ? !store.isPitchLinked : true);

    try {
      this.audio.playbackRate = targetRate;
      this.audio.defaultPlaybackRate = targetRate;
      this.audio.preservesPitch = targetPreserves;
      (this.audio as any).mozPreservesPitch = targetPreserves;
      (this.audio as any).webkitPreservesPitch = targetPreserves;
    } catch {
      // Audio element not initialized or properties unsupported
    }

    try {
      const isPitchLinked = store.isPitchLinked ?? true;
      const pitchSemitones = store.pitchSemitones ?? 0;
      const isReverbEnabled = store.isReverbEnabled ?? false;
      const reverbLevel = store.reverbLevel ?? 0.35;
      const isEqEnabled = store.isEqEnabled ?? false;
      const eqGains = store.eqGains ?? FLAT_EQ;
      const needsEffects =
        isReverbEnabled ||
        isEqActive(isEqEnabled, eqGains) ||
        (!isPitchLinked && Math.abs(pitchSemitones) >= 0.05);
      if (!needsEffects && !pitchShifter.isAttached()) return;
      pitchShifter.attach(this.audio);
      pitchShifter.update({
        pitchSemitones,
        isPitchLinked,
        isReverbEnabled,
        reverbLevel,
        isEqEnabled,
        eqGains,
      });
    } catch (err) {
      console.error("[PlayerRuntime] applyPlaybackRateAndPitch error:", err);
    }
  }

  private cancelFade(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  private fadeVolume(
    targetVolume: number,
    durationMs: number = 180,
    onComplete?: () => void,
  ): void {
    this.cancelFade();
    const startVolume = this.audio.volume;
    const diff = targetVolume - startVolume;
    if (Math.abs(diff) < 0.001 || durationMs <= 0) {
      this.audio.volume = Math.max(0, Math.min(1, targetVolume));
      onComplete?.();
      return;
    }

    const startTime = performance.now();

    const tick = () => {
      const now = performance.now();
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 0.5 - 0.5 * Math.cos(progress * Math.PI);
      const current = startVolume + diff * eased;
      this.audio.volume = Math.max(0, Math.min(1, current));

      if (progress < 1) {
        // audio fade ticks independently of display vsync in background
        this.fadeTimer = setTimeout(tick, 16);
      } else {
        this.fadeTimer = null;
        this.audio.volume = Math.max(0, Math.min(1, targetVolume));
        onComplete?.();
      }
    };

    this.fadeTimer = setTimeout(tick, 16);
  }

  private releaseStream() {
    this.releaseActiveStream?.();
    this.releaseActiveStream = null;
  }

  private watchFullSource(trackId: string, stream: PlaybackStream) {
    const { completed, needsFullSource } = stream;
    if (!completed || !needsFullSource) return;
    void completed
      .then((blob) => {
        if (this.currentTrackId !== trackId || this.audio.src !== stream.url)
          return;
        if (needsFullSource()) this.swapToFullSource(blob);
      })
      .catch(() => undefined);
  }

  private swapToFullSource(blob: Blob) {
    const position = this.audio.currentTime;
    const wasPlaying = !this.audio.paused;
    const url = URL.createObjectURL(blob);
    this.isResetting = true;
    this.releaseStream();
    if (this.activeBlobUrl) URL.revokeObjectURL(this.activeBlobUrl);
    this.activeBlobUrl = url;
    this.audio.src = url;
    this.attachedFromLiner = false;
    this.applyPlaybackRateAndPitch();
    const settle = () => {
      this.isResetting = false;
    };
    this.audio.addEventListener(
      "loadedmetadata",
      () => {
        this.audio.currentTime = position;
        if (wasPlaying) void this.audio.play().then(settle, settle);
        else settle();
      },
      { once: true },
    );
    log("cyan", "playback", "switched to the fully downloaded source");
  }

  private safeResetAudioElement() {
    this.isResetting = true;
    this.currentSessionExpiresAt = null;
    this.clearStallWatchdog();
    try {
      this.cancelFade();
      this.audio.pause();
      this.releaseStream();
      if (this.activeBlobUrl) {
        URL.revokeObjectURL(this.activeBlobUrl);
        this.activeBlobUrl = null;
      }
      this.audio.removeAttribute("src");
      this.audio.load();
      this.attachedTrackId = null;
    } catch {
    } finally {
      this.isResetting = false;
    }
  }

  // between tracks: silence the old source but keep it attached until the next one
  // is ready. Emptying the element here made Chromium drop the system media session
  // during every skip, so Windows controls / FluentFlyout lost Liner after a track change.
  private pauseForTransition() {
    this.isResetting = true;
    this.currentSessionExpiresAt = null;
    this.clearStallWatchdog();
    try {
      this.cancelFade();
      this.audio.pause();
    } catch {
    } finally {
      this.isResetting = false;
    }
  }

  private attachSource(url: string, isBlob: boolean, trackId: string) {
    const previousBlob = this.activeBlobUrl;
    this.audio.src = url;
    this.activeBlobUrl = isBlob ? url : null;
    this.attachedTrackId = trackId;
    this.attachedFromLiner = false;
    if (previousBlob && previousBlob !== url) URL.revokeObjectURL(previousBlob);
  }

  public cancelPendingLoad(): void {
    this.loadEpoch += 1;
    this.clearStallWatchdog();
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    this.backgroundCacheAbortController?.abort();
    this.backgroundCacheAbortController = null;
    this.currentTrackId = null;
    this.currentSessionExpiresAt = null;
    this.recoveryAttempts = 0;
    this.recoveryHoldUntilMs = null;
    this.loadingTrackId = null;
    this.currentLoadPromise = null;
    this.safeResetAudioElement();
    usePlayerStore.getState().setStatus("paused");
    log("cyan", "playback", "pending load cancelled");
  }

  public async preloadTrack(track: Track): Promise<void> {
    if (isLocalTrackId(track.id) || isSavedTrack(track.id)) return;
    if (this.currentTrackId === track.id) return;
    if (this.preloadingTrackId === track.id) return;

    const cached = await settleWithin(
      linerDb.getAudio(track.id),
      CACHE_LOOKUP_TIMEOUT_MS,
    );
    if (cached) return;
    // the user may have selected this track while the cache lookup was in
    // flight; its foreground load owns the bandwidth now
    if (this.currentTrackId === track.id) return;

    this.preloadAbortController?.abort();
    const controller = new AbortController();
    this.preloadAbortController = controller;
    this.preloadingTrackId = track.id;

    const generation = audioCache.currentGeneration();
    const promise = (async () => {
      try {
        // a speculative preload must not blacklist the track for a real play
        const stream = await resolvePlaybackStream(track, controller.signal, {
          recordFailure: false,
        });
        if (controller.signal.aborted) return;

        const blob = await this.downloadAudioBlob(stream, controller.signal);
        if (!blob || controller.signal.aborted) return;
        if (
          !(await audioCache.saveAudioBlob(
            track.id,
            blob,
            blob.type,
            generation,
          ))
        )
          return;
        await linerDb.putTrack(track);
        log(
          "green",
          "preload",
          `preloaded audio: "${track.title}" (${Math.round(blob.size / 1024)} KB)`,
        );
      } catch {
      } finally {
        if (this.preloadingTrackId === track.id) {
          this.preloadingTrackId = null;
          this.preloadingPromise = null;
          this.preloadAbortController = null;
        }
      }
    })();

    this.preloadingPromise = promise;
    await promise;
  }

  private pendingStartPositionMs = 0;

  public stop(): void {
    this.cancelPendingLoad();
    this.updateMediaSessionMetadata(null);
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "none";
      } catch {}
    }
  }

  public setPendingSeek(positionMs: number): void {
    this.pendingStartPositionMs = positionMs;
    usePlayerStore.getState().setPosition(positionMs);
    if (!this.audio.src || this.audio.src === window.location.href) return;
    const durationMs = usePlayerStore.getState().durationMs;
    try {
      if (this.audio.readyState >= 1) {
        applyMediaSeek(this.audio, positionMs, durationMs);
        return;
      }
      // The listener belongs to the load that is running now. Without this
      // guard a seek made before the metadata of track A arrived would fire on
      // track B's `loadedmetadata` and start B at A's position, which at worst
      // is past B's end and ends it immediately.
      const trackId = this.currentTrackId;
      const epoch = this.loadEpoch;
      this.audio.addEventListener(
        "loadedmetadata",
        () => {
          if (this.currentTrackId !== trackId || this.loadEpoch !== epoch)
            return;
          applyMediaSeek(this.audio, positionMs, durationMs);
        },
        { once: true },
      );
    } catch {}
  }

  public loadAndPlay(
    track: Track,
    startPositionMs: number = 0,
    bypassCache: boolean = false,
  ): Promise<void> {
    // selecting the same track again while it is still resolving (double click,
    // track row + play button, retry) must not abort the stream that is already
    // on its way and start over from zero
    if (
      !bypassCache &&
      this.loadingTrackId === track.id &&
      this.currentLoadPromise
    ) {
      return this.currentLoadPromise;
    }

    const promise = this.performLoadAndPlay(
      track,
      startPositionMs,
      bypassCache,
    ).finally(() => {
      if (this.currentLoadPromise === promise) {
        this.currentLoadPromise = null;
        this.loadingTrackId = null;
      }
    });
    this.loadingTrackId = track.id;
    this.currentLoadPromise = promise;
    return promise;
  }

  private async performLoadAndPlay(
    track: Track,
    startPositionMs: number = 0,
    bypassCache: boolean = false,
  ) {
    this.cancelFade();
    this.pendingStartPositionMs = startPositionMs;
    const epoch = ++this.loadEpoch;

    if (this.currentTrackId !== track.id) {
      this.recoveryAttempts = 0;
      this.recoveryHoldUntilMs = null;
    }

    if (this.preloadingTrackId) {
      // A preload downloads the whole file and has no deadline. Waiting for it
      // here meant selecting the track that was being preloaded could sit on
      // the old song (or silence) until that download finished. Drop it and let
      // the foreground progressive resolve start immediately; the cache it
      // would have filled is not worth a stalled play button.
      if (this.preloadingTrackId === track.id) {
        log(
          "cyan",
          "playback",
          `selected a track mid-preload — starting it now (${track.title})`,
        );
      }
      this.preloadAbortController?.abort();
      this.preloadAbortController = null;
      this.preloadingTrackId = null;
      this.preloadingPromise = null;
    }

    this.loadAbortController?.abort();
    const controller = new AbortController();
    this.loadAbortController = controller;

    this.backgroundCacheAbortController?.abort();
    const bgCacheController = new AbortController();
    this.backgroundCacheAbortController = bgCacheController;

    const store = usePlayerStore.getState();
    if (!store.keepSpeedAcrossTracks && this.currentTrackId !== track.id) {
      store.resetSpeedAndPitch();
    }
    this.currentTrackId = track.id;
    this.loadStartTime = performance.now();
    this.updateMediaSessionMetadata(track);

    store.setStatus("loading", null);
    store.setPosition(startPositionMs > 0 ? startPositionMs : 0);

    this.pauseForTransition();

    try {
      const cachedAudio =
        bypassCache || isSavedTrack(track.id)
          ? null
          : await settleWithin(
              linerDb.getAudio(track.id),
              CACHE_LOOKUP_TIMEOUT_MS,
            );
      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        return;
      }

      const isValidCachedBlob =
        Boolean(cachedAudio?.blob) &&
        cachedAudio!.blob.size > 0 &&
        (!cachedAudio!.blob.type ||
          cachedAudio!.blob.type.startsWith("audio/"));

      if (cachedAudio && !isValidCachedBlob) {
        void linerDb.deleteAudio(track.id);
        audioCache.deleteAudio(track.id);
      }

      if (cachedAudio && isValidCachedBlob) {
        this.currentSessionExpiresAt = null;
        void linerDb.putTrack(track);
        const blobUrl = URL.createObjectURL(cachedAudio.blob);
        this.attachSource(blobUrl, true, track.id);
        this.audio.volume = 0;
        this.audio.load();
        this.applyPlaybackRateAndPitch();

        const targetPosition =
          this.pendingStartPositionMs > 0
            ? this.pendingStartPositionMs
            : startPositionMs;
        this.seekWhenReady(epoch, targetPosition);
        log(
          "cyan",
          "playback",
          `audio cache hit for "${track.title}" (${Math.round(cachedAudio.byteSize / 1024)} KB)`,
        );

        if (epoch !== this.loadEpoch || controller.signal.aborted) return;

        await this.startPlayback(targetPosition);

        const audioStartLatencyMs = Math.round(
          performance.now() - this.loadStartTime,
        );

        if (epoch === this.loadEpoch) {
          usePlayerStore.getState().setStatus("playing");
          this.fadeVolume(usePlayerStore.getState().volume, 180);
        }
        logNowPlaying(track, true, audioStartLatencyMs);
        return;
      }

      const stream = await resolvePlaybackStream(track, controller.signal, {
        progressive: true,
      });
      this.ttfbMs = Math.round(performance.now() - this.loadStartTime);

      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        stream.release?.();
        log(
          "yellow",
          "playback",
          `superseded before stream ready (${track.title})`,
        );
        return;
      }

      const streamCodec = stream.codec;
      const streamBitrate = stream.bitrate;
      this.currentSessionExpiresAt = stream.expiresAtMs;
      log("cyan", "playback", `resolved stream for ${track.title}`);
      this.releaseStream();
      const url = stream.blob ? URL.createObjectURL(stream.blob) : stream.url;
      this.attachSource(url, Boolean(stream.blob), track.id);
      this.attachedFromLiner = Boolean(stream.fromLiner);
      this.releaseActiveStream = stream.release ?? null;
      this.watchFullSource(track.id, stream);
      this.audio.volume = 0;
      this.audio.load();
      this.applyPlaybackRateAndPitch();

      const targetPosition =
        this.pendingStartPositionMs > 0
          ? this.pendingStartPositionMs
          : startPositionMs;
      this.seekWhenReady(epoch, targetPosition);
      log(
        "green",
        "playback",
        `stream attached: ${streamCodec} ${streamBitrate} bps (${track.title})`,
      );

      if (epoch !== this.loadEpoch || controller.signal.aborted) return;

      await this.startPlayback(targetPosition);

      const audioStartLatencyMs = Math.round(
        performance.now() - this.loadStartTime,
      );

      if (epoch === this.loadEpoch) {
        usePlayerStore.getState().setStatus("playing");
        this.fadeVolume(usePlayerStore.getState().volume, 180);
        this.cacheAudioInBackground(track, stream, bgCacheController.signal);
      }
      logNowPlaying(track, false, audioStartLatencyMs);

      telemetry.trackPlaybackHealth("INIT_LATENCY", {
        trackId: track.id,
        codec: streamCodec,
        bitrate: streamBitrate,
        timeToFirstByteMs: this.ttfbMs,
        audioStartLatencyMs,
      });
    } catch (error) {
      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        return;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      if (error instanceof DOMException && error.name === "NotAllowedError") {
        log(
          "yellow",
          "playback",
          "autoplay blocked — waiting for user gesture",
        );
        usePlayerStore.getState().setStatus("paused");
        return;
      }

      // The stream resolved and was attached, but the element never started it.
      // Reporting the track as unplayable here skipped songs that a fresh load
      // (new url, no cache) plays, so try that once first.
      if (isStartFailure(error) && this.recoveryAttempts < 1) {
        const positionMs = Math.max(
          usePlayerStore.getState().positionMs,
          startPositionMs,
        );
        this.recoveryAttempts += 1;
        this.recoveryHoldUntilMs = positionMs + RECOVERY_HOLD_MS;
        log(
          "yellow",
          "playback",
          `stream did not start (${String(error)}) — reloading "${track.title}" once`,
        );
        void this.loadAndPlay(track, positionMs, true);
        return;
      }

      if (
        !IS_WEB_TARGET &&
        isBotCheckError(error) &&
        !isYoutubeSignedIn() &&
        !isYoutubeSignInDeclined() &&
        prefersSignInPrompt()
      ) {
        log("yellow", "playback", "youtube sign-in required, pausing");
        usePlayerStore.getState().setStatus("paused");
        requestYoutubeSignIn();
        return;
      }

      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Playback failed to start.";
      console.error("[LoadAndPlayError]", track.id, error);
      log("red", "playback", `failed: ${message}`);
      usePlayerStore.getState().setStatus("error", message);

      telemetry
        .reportError(error, {
          action: "playback_failed",
          trackId: track.id,
          title: track.title,
        })
        .catch(() => {});

      this.onError?.({ trackId: track.id, message });
    } finally {
      if (epoch === this.loadEpoch) {
        this.activePlayPromise = null;
      }
    }
  }

  /**
   * Starts the element as soon as a source is attached.
   *
   * This used to wait for `HAVE_FUTURE_DATA` (or three seconds) first, which put
   * a fixed delay in front of every slow source and did not make the start any
   * more reliable: `play()` already resolves once playback begins. What it needs
   * is a deadline instead — a source that stalls leaves `play()` pending for
   * good, which is the "loaded but never starts" case.
   */
  private async startPlayback(positionMs: number): Promise<void> {
    // a resume must land on its position before the first samples are audible;
    // metadata is enough for that and arrives long before the track buffers
    if (positionMs > 0 && this.audio.readyState < 1) {
      await this.waitForEvent("loadedmetadata", METADATA_TIMEOUT_MS);
    }
    const playPromise = this.audio.play();
    this.activePlayPromise = playPromise;
    // the deadline may win; the element's own rejection must not go unhandled
    playPromise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        playPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PlaybackStartTimeout()),
            START_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private waitForEvent(type: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.audio.removeEventListener(type, done);
        this.audio.removeEventListener("error", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.audio.addEventListener(type, done, { once: true });
      this.audio.addEventListener("error", done, { once: true });
    });
  }

  private seekWhenReady(epoch: number, positionMs: number) {
    if (positionMs <= 0) return;
    const durationMs = usePlayerStore.getState().durationMs;
    const apply = () => {
      if (epoch !== this.loadEpoch) return;
      applyMediaSeek(this.audio, positionMs, durationMs);
    };
    if (this.audio.readyState >= 1) {
      apply();
    } else {
      this.audio.addEventListener("loadedmetadata", apply, { once: true });
    }
  }

  public pause() {
    const epoch = ++this.loadEpoch;
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    this.loadingTrackId = null;
    this.currentLoadPromise = null;
    usePlayerStore.getState().setStatus("paused");
    log("cyan", "audio", "pause requested (fading out)");

    this.fadeVolume(0, 180, () => {
      if (epoch !== this.loadEpoch) return;
      this.audio.pause();
    });
  }

  public resume() {
    // A resume during a load used to bump the epoch and abort the stream that
    // was already resolving, so pressing play made the wait start over. The
    // load owns playback until it settles or times out.
    const pendingTrack = usePlayerStore.getState().currentTrack;
    // nothing selected: play() on an empty element only produces a rejected
    // promise and a "playing" state with no audio
    if (!pendingTrack) return;
    if (this.isLoadInFlightFor(pendingTrack.id)) {
      log("cyan", "audio", "resume ignored — the track is already loading");
      return;
    }

    const epoch = ++this.loadEpoch;
    this.loadAbortController?.abort();
    this.loadAbortController = null;

    const targetVolume = usePlayerStore.getState().volume;
    usePlayerStore.getState().setStatus("playing");
    pitchShifter.resumeContext();
    this.applyPlaybackRateAndPitch();
    log("cyan", "audio", "resume requested (fading in)");

    const currentTrack = pendingTrack;
    const isExpired =
      this.currentSessionExpiresAt !== null &&
      Date.now() >= this.currentSessionExpiresAt - 15_000;
    const hasMediaError = Boolean(this.audio.error);
    const hasValidSource =
      Boolean(this.audio.src) &&
      this.audio.src !== window.location.href &&
      !isExpired &&
      !hasMediaError;

    if (!hasValidSource && currentTrack) {
      void this.loadAndPlay(currentTrack, usePlayerStore.getState().positionMs);
      return;
    }

    if (this.audio.paused) {
      this.audio.volume = 0;
      const playPromise = this.audio.play();
      this.activePlayPromise = playPromise;
      playPromise
        .then(() => {
          if (epoch !== this.loadEpoch) return;
          this.fadeVolume(targetVolume, 180);
        })
        .catch((error) => {
          if (epoch !== this.loadEpoch) return;
          if (error.name === "NotAllowedError") {
            log("yellow", "audio", "play blocked — waiting for user gesture");
            usePlayerStore.getState().setStatus("paused");
          } else if (error.name !== "AbortError") {
            log("red", "audio", `play failed: ${String(error)}`);
            if (currentTrack && this.recoveryAttempts < 1) {
              this.recoveryAttempts++;
              log(
                "yellow",
                "playback",
                "resume failed — attempting cache/stream recovery",
              );
              void this.loadAndPlay(
                currentTrack,
                usePlayerStore.getState().positionMs,
                true,
              );
              return;
            }
            usePlayerStore.getState().setStatus("paused");
          }
        })
        .finally(() => {
          if (epoch === this.loadEpoch) this.activePlayPromise = null;
        });
    } else {
      this.fadeVolume(targetVolume, 180);
    }
  }

  public seek(positionMs: number, options: MediaSeekOptions = {}) {
    if (!this.audio.src || this.audio.src === window.location.href) return;
    const durationMs = usePlayerStore.getState().durationMs;
    try {
      if (this.audio.readyState >= 1) {
        applyMediaSeek(this.audio, positionMs, durationMs, options);
        return;
      }
      // A drag made before this track's metadata arrived must not land on the
      // next track's timeline. Only the track is checked: the load epoch also
      // changes on pause/resume, and a seek made while paused before metadata
      // should survive the resume.
      const trackId = this.currentTrackId;
      this.audio.addEventListener(
        "loadedmetadata",
        () => {
          if (this.currentTrackId !== trackId) return;
          applyMediaSeek(this.audio, positionMs, durationMs, options);
        },
        { once: true },
      );
    } catch {
      // Ignore seek error if media not yet ready
    }
  }

  private async downloadAudioBlob(
    stream: PlaybackStream,
    signal: AbortSignal,
  ): Promise<Blob | null> {
    if (stream.blob) return stream.blob;
    if (stream.completed) return stream.completed;
    const startedAt = performance.now();
    let bytes: Uint8Array<ArrayBuffer> | null;
    try {
      bytes = await downloadAudioBytes(stream.url, {
        contentLength: stream.contentLength,
        signal,
      });
    } catch (error) {
      if (stream.fromLiner && !signal.aborted)
        markLinerStreamFailed(`download: ${String(error)}`);
      throw error;
    }
    if (!bytes || signal.aborted) return null;
    const mimeType = stream.mimeType || "audio/webm";
    if (!mimeType.startsWith("audio/") && !mimeType.startsWith("video/"))
      return null;
    if (!isStandaloneAudioFile(bytes.subarray(0, 16))) {
      log(
        "yellow",
        "download",
        `not caching: stream is not a standalone audio file`,
      );
      return null;
    }
    log(
      "cyan",
      "download",
      `${Math.round(bytes.byteLength / 1024)} KB in ${Math.round(performance.now() - startedAt)}ms (${stream.contentLength ? "chunked" : "single request"})`,
    );
    return new Blob([bytes], { type: mimeType });
  }

  /**
   * Resolves true once the element has downloaded the track it is playing in
   * full, false if it stopped being the attached track or the load went away.
   * Only the browser build waits on this; see cacheAudioInBackground.
   */
  private waitForBufferedAudio(
    trackId: string,
    expectedDurationSec: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const isFullyBuffered = () => {
      if (this.attachedTrackId !== trackId) return false;
      const { duration: reported, buffered } = this.audio;
      // a webm stream without a duration header reports Infinity until it is
      // fully downloaded, so the catalog duration stands in for it
      const duration =
        Number.isFinite(reported) && reported > 0
          ? reported
          : expectedDurationSec;
      if (!Number.isFinite(duration) || duration <= 0) return false;
      for (let i = 0; i < buffered.length; i += 1) {
        // one range covering the whole file (a seek can leave gaps before it)
        if (buffered.start(i) <= 0.5 && buffered.end(i) >= duration - 0.5)
          return true;
      }
      return false;
    };

    if (signal.aborted) return Promise.resolve(false);
    if (isFullyBuffered()) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearInterval(timer);
        for (const type of AUDIO_BUFFER_EVENTS)
          this.audio.removeEventListener(type, check);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const check = () => {
        if (signal.aborted) finish(false);
        else if (isFullyBuffered()) finish(true);
      };
      const onAbort = () => finish(false);
      for (const type of AUDIO_BUFFER_EVENTS)
        this.audio.addEventListener(type, check);
      signal.addEventListener("abort", onAbort, { once: true });
      // `progress` drives this; the interval is for engines that only report
      // the new range on timeupdate.
      timer = setInterval(check, 1000);
    });
  }

  private cacheAudioInBackground(
    track: Track,
    stream: PlaybackStream,
    signal: AbortSignal,
  ) {
    if (isLocalTrackId(track.id) || isSavedTrack(track.id)) return;
    if (track.durationMs && track.durationMs > 20 * 60 * 1000) return;
    const generation = audioCache.currentGeneration();
    void (async () => {
      try {
        // In the browser a url stream is the same-origin relay the element is
        // already pulling, and fetching it a second time now would put two
        // copies of one song on the connection. A blob stream already holds its
        // bytes; a url stream waits until the element has the whole file, when
        // the extra copy can no longer starve playback.
        if (
          IS_WEB_TARGET &&
          !stream.blob &&
          !stream.completed &&
          !(await this.waitForBufferedAudio(
            track.id,
            (track.durationMs ?? 0) / 1000,
            signal,
          ))
        )
          return;
        const blob = await this.downloadAudioBlob(stream, signal);
        if (!blob || signal.aborted) return;
        if (
          !(await audioCache.saveAudioBlob(
            track.id,
            blob,
            blob.type,
            generation,
          ))
        )
          return;
        await linerDb.putTrack(track);
        log(
          "green",
          "playback",
          `background cached: ${track.title} (${Math.round(blob.size / 1024)} KB)`,
        );
      } catch {}
    })();
  }
}

export const playerRuntime =
  typeof window !== "undefined" ? new PlayerRuntime() : null;
