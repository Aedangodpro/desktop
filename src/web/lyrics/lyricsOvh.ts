import type { LyricsCandidate } from "@/shared/contracts/lyrics";
import { buildQuality } from "./ranking";
import { cleanLyricsTitle } from "./lyricsTitle";
import { withTimeout } from "./signal";
import type { LyricsHint, LyricsProvider } from "./types";

/**
 * Lyrics.ovh is the last-resort provider of the browser build.
 *
 * It only has unsynced text, so it is registered with `tier: "plain"` and is
 * only asked once every synced source came back empty. It answers with
 * `access-control-allow-origin: *`, so no relay is involved.
 */

const BASE = "https://api.lyrics.ovh/v1";
const TIMEOUT_MS = 8_000;

interface LyricsOvhResponse {
  lyrics?: unknown;
}

function cleanPlainLyrics(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function request(url: string, signal?: AbortSignal): Promise<Response> {
  const scope = withTimeout(signal, TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: scope.signal,
      headers: { accept: "application/json" },
    });
  } finally {
    scope.dispose();
  }
}

export async function fetchLyricsOvh(
  hint: LyricsHint,
  signal?: AbortSignal,
): Promise<LyricsCandidate | null> {
  const title = cleanLyricsTitle(hint.title);
  const artist = hint.artist.trim();
  if (!title || !artist) return null;

  const url = `${BASE}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;

  try {
    const response = await request(url, signal);
    if (!response.ok) return null;
    const payload = (await response.json()) as LyricsOvhResponse;
    if (typeof payload?.lyrics !== "string") return null;
    const content = cleanPlainLyrics(payload.lyrics);
    if (!content) return null;

    return {
      provider: "Lyrics.ovh",
      lyrics: { format: "plain", content },
      contentKind: "plain",
      syncLevel: "plain",
      matchedTrack: {
        title,
        artists: [artist],
        ...(hint.durationMs ? { durationMs: hint.durationMs } : {}),
      },
      quality: buildQuality({
        syncLevel: "plain",
        match: 62,
        content: 64,
        source: 35,
        reasons: ["lyrics.ovh plain text"],
      }),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export const lyricsOvhProvider: LyricsProvider = {
  id: "Lyrics.ovh",
  priority: 40,
  tier: "plain",
  maxSyncLevel: "plain",
  fetchLyrics: fetchLyricsOvh,
};
