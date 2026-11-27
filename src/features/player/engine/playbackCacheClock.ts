/**
 * Counts how much of the attached audio element has actually played, so the
 * cache only takes tracks that were listened to. A resume or a seek into the
 * middle counts from wherever playback started, while loading, pausing and
 * jumping through the timeline do not.
 *
 * Each observation contributes the smaller of the wall time since the previous
 * one and the advance of the media clock. A seek forward therefore adds at most
 * the time spent waiting for it, and a background tab whose `timeupdate`
 * arrives once every few seconds still counts the playback in between.
 */
export class PlaybackCacheClock {
  private playedMs = 0;
  private lastPositionSec: number;
  private lastObservedAtMs: number;

  constructor(
    private readonly audio: Pick<HTMLMediaElement, "currentTime">,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.lastPositionSec = audio.currentTime;
    this.lastObservedAtMs = nowMs();
  }

  /** Observes the element once and returns the played milliseconds so far. */
  observe(): number {
    const observedAtMs = this.nowMs();
    const positionSec = this.audio.currentTime;
    const wallMs = Math.max(0, observedAtMs - this.lastObservedAtMs);
    const mediaMs = Math.max(0, (positionSec - this.lastPositionSec) * 1000);
    this.playedMs += Math.min(wallMs, mediaMs);
    this.lastPositionSec = positionSec;
    this.lastObservedAtMs = observedAtMs;
    return this.playedMs;
  }
}
