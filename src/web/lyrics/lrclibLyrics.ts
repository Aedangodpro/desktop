import type { LyricsCandidate } from "@/shared/contracts/lyrics";

/**
 * LRCLIB provider for the browser build.
 *
 * Lyrics normally stream from the Liner API, which a signed-out browser cannot
 * reach (and which answers every `/v1` call with 403 today). LRCLIB serves the
 * same thing over CORS — it sends `access-control-allow-origin: *` and returns
 * synced LRC — so the web build can resolve lyrics without the API.
 */

const BASE = "https://lrclib.net/api";
const TIMEOUT_MS = 8_000;

interface LrclibResult {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LyricsHint {
  title: string;
  artist: string;
  durationMs?: number;
}

// YouTube titles carry release noise that LRCLIB does not index
const NOISE =
  /\b(official|video|audio|lyric|lyrics|visuali[sz]er|remaster|remastered|hd|hq|4k|mv|m\/v|explicit)\b/i;

export function cleanLyricsTitle(title: string): string {
  const stripped = title.replace(/\s*[[(][^\])]*[\])]/g, (segment) =>
    NOISE.test(segment) ? "" : segment,
  );
  const withoutSuffix = stripped.replace(
    /\s*[-–]\s*(official|video|audio|lyrics?|visuali[sz]er).*$/i,
    "",
  );
  return withoutSuffix.trim() || title.trim();
}

function toCandidate(result: LrclibResult): LyricsCandidate | null {
  if (result.instrumental) return null;
  const synced = result.syncedLyrics?.trim();
  const plain = result.plainLyrics?.trim();
  const content = synced || plain;
  if (!content) return null;
  const lineSynced = Boolean(synced);
  return {
    provider: "LRCLIB",
    lyrics: { format: lineSynced ? "lrc" : "plain", content },
    contentKind: lineSynced ? "line_synced" : "plain",
    syncLevel: lineSynced ? "line_level" : "plain",
    matchedTrack: {
      ...(result.trackName ? { title: result.trackName } : {}),
      ...(result.artistName ? { artists: [result.artistName] } : {}),
      ...(result.duration
        ? { durationMs: Math.round(result.duration * 1000) }
        : {}),
    },
    quality: {
      total: lineSynced ? 78 : 55,
      match: 70,
      content: lineSynced ? 80 : 60,
      sync: lineSynced ? 85 : 0,
      source: 60,
      reasons: ["lrclib direct"],
    },
  };
}

function request(url: string, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { accept: "application/json" },
  });
}

function closest(
  results: LrclibResult[],
  durationSeconds: number | null,
): LrclibResult | null {
  const usable = results.filter(
    (item) => !item.instrumental && (item.syncedLyrics || item.plainLyrics),
  );
  if (!usable.length) return null;
  return usable.sort((a, b) => {
    const syncRank =
      Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics));
    if (syncRank) return syncRank;
    if (durationSeconds === null) return 0;
    return (
      Math.abs((a.duration ?? 0) - durationSeconds) -
      Math.abs((b.duration ?? 0) - durationSeconds)
    );
  })[0]!;
}

export async function fetchLrclibLyrics(
  hint: LyricsHint,
  signal?: AbortSignal,
): Promise<LyricsCandidate | null> {
  const title = cleanLyricsTitle(hint.title);
  const artist = hint.artist.trim();
  if (!title || !artist) return null;
  const durationSeconds = hint.durationMs
    ? Math.round(hint.durationMs / 1000)
    : null;

  const exact = new URLSearchParams({
    track_name: title,
    artist_name: artist,
  });
  if (durationSeconds) exact.set("duration", String(durationSeconds));

  try {
    const response = await request(`${BASE}/get?${exact.toString()}`, signal);
    if (response.ok) {
      const candidate = toCandidate((await response.json()) as LrclibResult);
      if (candidate) return candidate;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  try {
    const search = new URLSearchParams({ q: `${title} ${artist}` });
    const response = await request(
      `${BASE}/search?${search.toString()}`,
      signal,
    );
    if (!response.ok) return null;
    const results = (await response.json()) as LrclibResult[];
    if (!Array.isArray(results)) return null;
    const best = closest(results, durationSeconds);
    return best ? toCandidate(best) : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
