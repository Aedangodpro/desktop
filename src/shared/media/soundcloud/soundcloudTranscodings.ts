import type {
  SoundCloudTrackInfo,
  SoundCloudTranscoding,
} from "./soundcloudTrack";

export type SoundCloudUnavailableReason =
  | "not_found"
  | "blocked"
  | "preview_only"
  | "not_streamable"
  | "no_playable_transcoding"
  | "encrypted";

export class SoundCloudUnavailableError extends Error {
  constructor(readonly reason: SoundCloudUnavailableReason) {
    super(`SoundCloud track unavailable (${reason})`);
    this.name = "SoundCloudUnavailableError";
  }
}

export type SoundCloudCodec = "mp3" | "aac" | "opus";

export interface TranscodingFormat {
  codec: SoundCloudCodec;
  mimeType: string;
  bitrate: number;
}

const PREVIEW_TOLERANCE_MS = 5_000;

function isPreviewOnly(track: SoundCloudTrackInfo): boolean {
  if (track.policy === "SNIP") return true;
  if (
    track.transcodings.length > 0 &&
    track.transcodings.every((transcoding) => transcoding.snipped)
  )
    return true;
  return Boolean(
    track.durationMs &&
    track.fullDurationMs &&
    track.durationMs < track.fullDurationMs - PREVIEW_TOLERANCE_MS,
  );
}

export function transcodingFormat(
  transcoding: SoundCloudTranscoding,
): TranscodingFormat {
  const { mimeType, preset } = transcoding;
  const kbps = Number(/(\d+)k/i.exec(preset)?.[1]);
  const bitrate = (fallback: number) =>
    Number.isFinite(kbps) && kbps > 0 ? kbps * 1000 : fallback;
  if (mimeType.includes("opus") || preset.startsWith("opus")) {
    return {
      codec: "opus",
      mimeType: 'audio/ogg; codecs="opus"',
      bitrate: bitrate(64_000),
    };
  }
  if (
    mimeType.includes("mp4") ||
    mimeType.includes("aac") ||
    preset.startsWith("aac")
  ) {
    return { codec: "aac", mimeType: "audio/mp4", bitrate: bitrate(128_000) };
  }
  return { codec: "mp3", mimeType: "audio/mpeg", bitrate: bitrate(128_000) };
}

function transcodingRank(transcoding: SoundCloudTranscoding): number {
  const isMpeg = transcoding.mimeType.startsWith("audio/mpeg");
  if (transcoding.protocol === "progressive") return isMpeg ? 0 : 1;
  if (isMpeg) return 2;
  if (transcoding.mimeType.includes("mp4")) return 3;
  return 4;
}

/**
 * A format that can be fetched and decoded without a DRM licence.
 *
 * Monetized tracks expose `cbc-encrypted-hls` / `ctr-encrypted-hls` (FairPlay,
 * Widevine) and an `abr_sq` master playlist. Their segments download fine but
 * are encrypted samples, so handing one to `<audio>` is silence at best. Search
 * hits are filtered with this too, so a DRM-only upload is never offered as a
 * candidate in the first place.
 */
export function isClearStreamFormat(
  protocol: string,
  mimeType: string,
  snipped: boolean,
): boolean {
  if (snipped) return false;
  if (protocol === "progressive") return true;
  return protocol === "hls" && !mimeType.includes("mpegurl");
}

function isClearTranscoding(transcoding: SoundCloudTranscoding): boolean {
  return isClearStreamFormat(
    transcoding.protocol,
    transcoding.mimeType,
    transcoding.snipped,
  );
}

export function playableTranscodings(
  track: SoundCloudTrackInfo,
): SoundCloudTranscoding[] {
  if (track.policy === "BLOCK") throw new SoundCloudUnavailableError("blocked");
  if (isPreviewOnly(track))
    throw new SoundCloudUnavailableError("preview_only");
  if (!track.streamable) throw new SoundCloudUnavailableError("not_streamable");
  const playable = track.transcodings
    .filter(isClearTranscoding)
    .sort((left, right) => transcodingRank(left) - transcodingRank(right));
  if (playable.length === 0)
    throw new SoundCloudUnavailableError("no_playable_transcoding");
  return playable;
}
