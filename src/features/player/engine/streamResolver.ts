import {
  isYoutubeSignedIn,
  prefersAccountPlayback,
  resolveDirectAudioStream,
  openTvAudioStream,
  resolveTvAudioStream,
  STREAMS_REFUSED_MESSAGE,
  toVideoId,
} from "@/shared/youtube";
import { IOS_PROFILE } from "@/shared/youtube/innertube/playbackProfiles";
import type { InnertubeProfile } from "@/shared/youtube/innertube/innertubeClient";
import {
  isOfflineMode,
  OFFLINE_UNAVAILABLE_MESSAGE,
} from "@/features/connectivity/store/offlineModeStore";
import {
  resolveSoundCloudStream,
  toSoundCloudTrackId,
} from "@/shared/media/soundcloud";
import { resolveLinerStream } from "@/shared/media/liner/linerPlayback";
import { isLocalTrackId, localTrackAudioUrl } from "@/shared/media/local";
import { savedAudioUrl, savedTrackRecord } from "@/shared/media/saved";
import { isAbortError } from "@/shared/utils/abort";
import { log } from "@/shared/utils/logger";
import { rememberStreamOrigin } from "./nowPlayingLog";
import {
  fromInnertubeStream,
  fromLinerStream,
  fromSoundCloudStream,
  fromTvProgressiveStream,
  fromTvStream,
  type PlayableTrack,
  type PlaybackStream,
} from "./playbackStream";
import { findYoutubeStandIn } from "./youtubeStandIn";
import { findAlternateUploads } from "./playbackAlternates";
import { findSoundCloudUploads } from "./soundcloudFallback";
import { findExactSongVersion } from "./exactSongVersion";
import { appAllowsAccountPlayback } from "./accountPlayback";
import { IS_WEB_TARGET } from "@/shared/config/runtimeTarget";
import { mediaProxyUrl } from "@/web/proxyUrls";

export interface ResolveStreamOptions {
  progressive?: boolean;
}

export type {
  BufferedPlaybackStream,
  PlayableTrack,
  PlaybackStream,
  UrlPlaybackStream,
} from "./playbackStream";

async function resolveTvAudio(
  videoId: string,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  if (progressive)
    return fromTvProgressiveStream(
      await openTvAudioStream(videoId, { signal }),
    );
  return fromTvStream(await resolveTvAudioStream(videoId, { signal }));
}

async function resolveYoutubeAudio(
  videoId: string,
  progressive: boolean,
  signal?: AbortSignal,
  profiles?: readonly InnertubeProfile[],
): Promise<PlaybackStream> {
  if (
    isYoutubeSignedIn() &&
    prefersAccountPlayback() &&
    (await appAllowsAccountPlayback())
  ) {
    try {
      const stream = await resolveTvAudio(videoId, progressive, signal);
      log("cyan", "playback", `resolved youtube tv audio for ${videoId}`);
      return stream;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      log("yellow", "playback", `youtube tv playback failed: ${String(error)}`);
    }
  }
  return fromInnertubeStream(
    await resolveDirectAudioStream(videoId, {
      signal,
      ...(profiles ? { profiles } : {}),
    }),
  );
}

async function resolveYoutubeStandIn(
  track: PlayableTrack,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  const videoId = await findYoutubeStandIn(track, signal);
  if (!videoId) throw new Error("No matching YouTube track found");
  log(
    "cyan",
    "playback",
    `resolved youtube stand-in ${videoId} for "${track.title}"`,
  );
  const stream = await resolveYoutubeAudio(videoId, progressive, signal);
  stream.standIn = true;
  return stream;
}

async function resolveSoundCloud(
  track: PlayableTrack,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  try {
    return fromSoundCloudStream(
      await resolveSoundCloudStream(track.id, { signal }),
    );
  } catch (soundCloudError) {
    if (isAbortError(soundCloudError, signal)) throw soundCloudError;
    log(
      "yellow",
      "playback",
      `soundcloud resolution failed, searching youtube: ${String(soundCloudError)}`,
    );
    try {
      return await resolveYoutubeStandIn(track, progressive, signal);
    } catch (standInError) {
      if (isAbortError(standInError, signal)) throw standInError;
      throw soundCloudError;
    }
  }
}

/** Each re-upload is a fresh chance at the bot check; three is the sweet spot. */
const MAX_ALTERNATE_ATTEMPTS = 3;

/**
 * Re-uploads are probed with the client that actually hands audio to music
 * videos, instead of sweeping every profile again, so more uploads fit in the
 * same request budget.
 */
const REPLACEMENT_PROFILES: readonly InnertubeProfile[] | undefined =
  IS_WEB_TARGET ? [IOS_PROFILE] : undefined;

async function findPlaybackReplacements(
  track: PlayableTrack,
  refusedVideoId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const ids: string[] = [];
  // the catalog match is quality-vetted, so it gets the first try
  const curated = await findYoutubeStandIn(track, signal, refusedVideoId).catch(
    () => null,
  );
  if (curated && curated !== refusedVideoId) ids.push(curated);
  const uploads = await findAlternateUploads(
    track,
    refusedVideoId,
    signal,
  ).catch(() => []);
  for (const id of uploads) if (!ids.includes(id)) ids.push(id);
  return ids.slice(0, MAX_ALTERNATE_ATTEMPTS);
}

/**
 * The same recording on SoundCloud, which does not bot-check the network the
 * way YouTube does. Used when YouTube refuses the track and its re-uploads, so
 * a flagged address still plays instead of skipping.
 */
async function playSoundCloudUploads(
  track: PlayableTrack,
  uploads: readonly string[],
  signal?: AbortSignal,
): Promise<PlaybackStream | null> {
  let lastError: unknown = null;
  for (const upload of uploads) {
    try {
      const stream = fromSoundCloudStream(
        await resolveSoundCloudStream(upload, { signal }),
      );
      stream.standIn = true;
      log(
        "cyan",
        "playback",
        `youtube refused "${track.title}", playing the soundcloud upload ${upload}`,
      );
      return stream;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      lastError = error;
    }
  }
  // a match that will not open is different from no match at all, and the
  // difference is invisible without this line
  if (uploads.length > 0)
    log(
      "yellow",
      "playback",
      `soundcloud upload for "${track.title}" did not play: ${String(lastError)}`,
    );
  return null;
}

/**
 * YouTube bot-checks individual uploads (Topic-channel audio especially) even
 * when the rest of the catalog plays. Another upload of the same recording is
 * usually accepted, so a refused video is retried as a stand-in before the
 * track is reported unavailable.
 */
async function resolveYoutubeVideoWithStandIn(
  track: PlayableTrack,
  videoId: string,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  try {
    return await resolveYoutubeAudio(videoId, progressive, signal);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    // Every profile's stream was refused, so this network is blocked for
    // YouTube and a different video would be refused too: only another catalog
    // can play the track.
    const everyClientRefused =
      error instanceof Error &&
      error.message.startsWith(STREAMS_REFUSED_MESSAGE);
    // The other catalog is searched now rather than after the YouTube probes:
    // it is one relayed request that runs next to them, and when this network
    // is refused it is the only source that can answer at all. Its own
    // controller follows the load's signal, and cancels a search nobody will
    // read once a replacement plays: the search costs two relayed requests and
    // logs a line per rejected hit otherwise.
    const soundCloudController = new AbortController();
    const forwardAbort = () => soundCloudController.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const soundCloudSearch = findSoundCloudUploads(
      track,
      soundCloudController.signal,
    ).catch(() => [] as string[]);
    try {
      if (!everyClientRefused) {
        const replacements = await findPlaybackReplacements(
          track,
          videoId,
          signal,
        );
        for (const replacement of replacements) {
          log(
            "yellow",
            "playback",
            `youtube refused ${videoId}, trying the stand-in ${replacement} for "${track.title}"`,
          );
          try {
            const stream = await resolveYoutubeAudio(
              replacement,
              progressive,
              signal,
              REPLACEMENT_PROFILES,
            );
            stream.standIn = true;
            return stream;
          } catch (replacementError) {
            if (isAbortError(replacementError, signal)) throw replacementError;
          }
        }
      }
      const soundCloud = await playSoundCloudUploads(
        track,
        await soundCloudSearch,
        signal,
      );
      if (soundCloud) return soundCloud;
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      soundCloudController.abort();
    }
  }
}

async function resolveYoutubeTrack(
  track: PlayableTrack,
  rowVideoId: string,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  const songId = track.audioVariant
    ? await findExactSongVersion(track, rowVideoId, signal)
    : null;
  if (songId)
    log(
      "cyan",
      "playback",
      `album row ${rowVideoId} is a ${track.audioVariant}, playing the song ${songId}`,
    );
  const videoId = songId ?? rowVideoId;
  const liner = await resolveLinerStream(videoId, signal);
  if (liner) {
    log("cyan", "playback", `resolved liner audio (r2) for "${track.title}"`);
    return fromLinerStream(liner, track);
  }
  return resolveYoutubeVideoWithStandIn(track, videoId, progressive, signal);
}

// A browser cannot load googlevideo or presigned R2 urls directly: neither host
// sends CORS headers, and the element uses `crossorigin` for the effects graph.
// Everything playable is routed through the same-origin relay instead.
function withWebMediaProxy(stream: PlaybackStream): PlaybackStream {
  if (!IS_WEB_TARGET) return stream;
  if (!("url" in stream) || !stream.url) return stream;
  return { ...stream, url: mediaProxyUrl(stream.url) };
}

export async function resolvePlaybackStream(
  track: PlayableTrack,
  signal?: AbortSignal,
  options: ResolveStreamOptions = {},
): Promise<PlaybackStream> {
  const stream = withWebMediaProxy(await resolveStream(track, signal, options));
  rememberStreamOrigin(track.id, stream);
  return stream;
}

async function resolveStream(
  track: PlayableTrack,
  signal?: AbortSignal,
  options: ResolveStreamOptions = {},
): Promise<PlaybackStream> {
  const progressive = options.progressive ?? false;
  if (isLocalTrackId(track.id))
    return {
      url: localTrackAudioUrl(track.id),
      source: "local",
      expiresAtMs: null,
      mimeType: "",
      codec: "local",
      bitrate: 0,
    };
  const saved = savedTrackRecord(track.id);
  if (saved)
    return {
      url: savedAudioUrl(saved),
      expiresAtMs: null,
      mimeType: saved.mimeType,
      codec: "local",
      bitrate: 0,
    };
  if (isOfflineMode()) throw new Error(OFFLINE_UNAVAILABLE_MESSAGE);
  const resolve = (bounded: AbortSignal | undefined) => {
    if (toSoundCloudTrackId(track.id))
      return resolveSoundCloud(track, progressive, bounded);
    const videoId = toVideoId(track.id);
    if (videoId)
      return resolveYoutubeTrack(track, videoId, progressive, bounded);
    return resolveYoutubeStandIn(track, progressive, bounded);
  };
  return progressive ? withResolveTimeout(signal, resolve) : resolve(signal);
}

export const RESOLVE_TIMEOUT_MS = 25_000;
export const RESOLVE_TIMEOUT_MESSAGE =
  "Timed out looking for a playable stream";

export async function withResolveTimeout<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timedOut = new Error(RESOLVE_TIMEOUT_MESSAGE);
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timedOut);
      reject(timedOut);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}
