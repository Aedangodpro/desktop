/**
 * Seeking helpers.
 *
 * Positions come from sliders, media-session commands, resume bookmarks and
 * retry paths, so they can be negative, past the end, or NaN while metadata is
 * still missing. Clamping keeps `currentTime` inside the media.
 *
 * `fastSeek` lands on the nearest cue point, which is what makes scrubbing feel
 * immediate, but it is not frame-exact. It is therefore opt-in (`fast: true`)
 * for timeline scrubbing only; media-session seeks, resume positions and retry
 * seeks stay exact.
 */

export interface SeekableMedia {
  currentTime: number;
  duration: number;
  fastSeek?: (time: number) => void;
}

export interface MediaSeekOptions {
  /** scrubbing only: approximate seek to the nearest cue point */
  fast?: boolean;
}

export function clampSeekSeconds(
  positionMs: number,
  durationSeconds: number,
): number {
  const seconds = Number.isFinite(positionMs) ? positionMs / 1000 : 0;
  const max =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(max, seconds));
}

/**
 * Applies a position in milliseconds and returns the seconds actually used.
 * `fallbackDurationMs` covers the window before `duration` is known.
 */
export function applyMediaSeek(
  media: SeekableMedia,
  positionMs: number,
  fallbackDurationMs = 0,
  options: MediaSeekOptions = {},
): number {
  const durationSeconds =
    Number.isFinite(media.duration) && media.duration > 0
      ? media.duration
      : fallbackDurationMs > 0
        ? fallbackDurationMs / 1000
        : 0;
  const seconds = clampSeekSeconds(positionMs, durationSeconds);

  try {
    if (options.fast === true && typeof media.fastSeek === "function") {
      media.fastSeek(seconds);
    } else {
      media.currentTime = seconds;
    }
  } catch {
    try {
      media.currentTime = seconds;
    } catch {
      // media not seekable yet; the caller retries on loadedmetadata
    }
  }
  return seconds;
}
