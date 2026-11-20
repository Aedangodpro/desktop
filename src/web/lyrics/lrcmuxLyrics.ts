import type { LyricsCandidate } from "@/shared/contracts/lyrics";
import { cleanLyricsTitle } from "./lyricsTitle";
import type { LyricsHint, LyricsProvider } from "./types";

/**
 * LRCMUX provider for the browser build.
 *
 * LRCMUX aggregates Deezer, KuGou and YouTube Music and answers with the best
 * result any of them has: per-word timings, per-line timings or plain text.
 * The API serves `access-control-allow-origin: *` and answers GET preflights,
 * so a browser can call it directly without the media relay.
 *
 * `format=json` is requested rather than `format=lrc` because the JSON carries
 * an explicit end time for every word, which LRC text cannot express.
 */

const BASE = "https://api.lrcmux.dev";
const TIMEOUT_MS = 8_000;
const DEFAULT_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

// LRCMUX allows 60 requests per minute and asks clients to honour
// `Retry-After`. A 429 parks the provider for that window instead of
// hammering it; lyrics fall through to the next source meanwhile.
let cooldownUntil = 0;

export function resetLrcmuxCooldown(): void {
  cooldownUntil = 0;
}

type LrcmuxLevel = "word" | "line" | "none";

interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

interface TimedLine {
  text: string;
  /** null when the source returned no timing for this line (plain lyrics) */
  startMs: number | null;
  endMs: number;
  words: TimedWord[];
  /** the source really supplied word timings for this line */
  hasWords: boolean;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeWords(
  raw: unknown,
  lineStart: number,
  lineEnd: number,
): TimedWord[] {
  if (!Array.isArray(raw)) return [];
  const words: TimedWord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const word = entry as { text?: unknown; start?: unknown; end?: unknown };
    if (typeof word.text !== "string") continue;
    const start = asNumber(word.start);
    if (start === null) continue;
    const end = asNumber(word.end);
    words.push({
      text: word.text,
      startMs: Math.round(start),
      endMs: Math.round(end ?? start),
    });
  }
  // keep timings monotonic and inside their line
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];
    if (word.endMs < word.startMs) word.endMs = word.startMs;
    if (next && next.startMs < word.startMs) next.startMs = word.startMs;
    if (i === words.length - 1 && word.endMs <= word.startMs) {
      word.endMs = Math.max(word.startMs + 1, lineEnd > lineStart ? lineEnd : 0);
    }
  }
  return words;
}

function normalizeLines(raw: unknown): TimedLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: TimedLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const line = entry as {
      text?: unknown;
      start?: unknown;
      end?: unknown;
      words?: unknown;
    };
    const start = asNumber(line.start);
    const startMs = start === null ? null : Math.round(start);
    const rawEnd = asNumber(line.end);
    const endMs =
      startMs === null
        ? 0
        : Math.max(startMs, Math.round(rawEnd ?? startMs));
    const words = normalizeWords(line.words, startMs ?? 0, endMs);
    const text =
      (typeof line.text === "string" ? line.text : "").trim() ||
      words
        .map((word) => word.text)
        .join("")
        .trim();
    if (!text) continue;
    lines.push({
      text,
      startMs,
      endMs,
      words:
        words.length === 0 && startMs !== null
          ? [{ text, startMs, endMs: Math.max(startMs + 1, endMs) }]
          : words,
      hasWords: words.length > 0,
    });
  }
  return lines.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
}

/** Musixmatch-style richsync JSON, which `parseRawLyrics` understands. */
function toRichsyncContent(lines: TimedLine[]): string {
  const payload = lines.map((line) => {
    const startMs = line.startMs ?? 0;
    const words = line.words.map((word, index) => ({
      c:
        index === line.words.length - 1 ? word.text.trimEnd() : word.text,
      o: Math.round(word.startMs) / 1000,
    }));
    // the last word's own end is more accurate than the line end, which often
    // includes the silence before the next line
    const endMs = Math.max(
      startMs + 1,
      line.words[line.words.length - 1]?.endMs ?? line.endMs,
    );
    return {
      ts: Math.round(startMs) / 1000,
      te: endMs / 1000,
      l: words,
    };
  });
  return JSON.stringify(payload);
}

function lrcTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}]`;
}

function toLrcContent(lines: TimedLine[]): string {
  return lines
    .filter((line) => line.startMs !== null)
    .map((line) => `${lrcTimestamp(line.startMs!)}${line.text}`)
    .join("\n");
}

/**
 * Providers sometimes match a different recording of the same song (a remix,
 * an extended mix, a live take). Timed lyrics from it are seconds out of
 * sync, so they are rejected and the caller falls through to the next source.
 */
function isDifferentRecording(
  expectedMs: number | undefined,
  actualMs: number | undefined,
): boolean {
  if (!expectedMs || expectedMs <= 0 || !actualMs || actualMs <= 0) return false;
  const tolerance = Math.max(8_000, expectedMs * 0.05);
  return Math.abs(actualMs - expectedMs) > tolerance;
}

function toCandidate(
  payload: unknown,
  expectedDurationMs?: number,
): LyricsCandidate | null {
  if (!payload || typeof payload !== "object") return null;
  const response = payload as {
    track?: {
      title?: unknown;
      artist?: unknown;
      album?: unknown;
      duration?: unknown;
    };
    meta?: {
      level?: unknown;
      instrumental?: unknown;
      source?: { id?: unknown; name?: unknown } | null;
    };
    lines?: unknown;
  };

  if (response.meta?.instrumental === true) return null;

  const lines = normalizeLines(response.lines);
  if (!lines.length) return null;

  const declared = response.meta?.level;
  const timed = lines.filter((line) => line.startMs !== null);
  const hasWordLines = timed.some((line) => line.hasWords);
  const level: LrcmuxLevel =
    declared === "word" && hasWordLines
      ? "word"
      : (declared === "line" || declared === "word") && timed.length > 0
        ? "line"
        : "none";

  const sourceId =
    typeof response.meta?.source?.id === "string"
      ? response.meta.source.id
      : "lrcmux";
  const reasons = [`lrcmux ${sourceId}`];

  const track: LyricsCandidate["matchedTrack"] = {};
  if (typeof response.track?.title === "string") {
    track.title = response.track.title;
  }
  if (typeof response.track?.artist === "string") {
    track.artists = [response.track.artist];
  }
  const durationSeconds = asNumber(response.track?.duration);
  if (durationSeconds && durationSeconds > 0) {
    track.durationMs = Math.round(durationSeconds * 1000);
  }
  if (
    level !== "none" &&
    isDifferentRecording(expectedDurationMs, track.durationMs)
  ) {
    return null;
  }

  if (level === "word") {
    return {
      provider: "LRCMUX",
      lyrics: { format: "richsync", content: toRichsyncContent(timed) },
      contentKind: "word_synced",
      syncLevel: "word_level",
      matchedTrack: track,
      quality: {
        total: 92,
        match: 78,
        content: 92,
        sync: 95,
        source: 72,
        reasons,
      },
    };
  }

  if (level === "line") {
    return {
      provider: "LRCMUX",
      lyrics: { format: "lrc", content: toLrcContent(timed) },
      contentKind: "line_synced",
      syncLevel: "line_level",
      matchedTrack: track,
      quality: {
        total: 82,
        match: 78,
        content: 84,
        sync: 82,
        source: 72,
        reasons,
      },
    };
  }

  return {
    provider: "LRCMUX",
    lyrics: {
      format: "plain",
      content: lines.map((line) => line.text).join("\n"),
    },
    contentKind: "plain",
    syncLevel: "plain",
    matchedTrack: track,
    quality: {
      total: 60,
      match: 70,
      content: 68,
      sync: 0,
      source: 72,
      reasons,
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

function parkOnRateLimit(response: Response): void {
  const retryAfter = Number(response.headers.get("retry-after"));
  const ms = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
    : DEFAULT_BACKOFF_MS;
  cooldownUntil = Date.now() + ms;
}

export async function fetchLrcmuxLyrics(
  hint: LyricsHint,
  signal?: AbortSignal,
): Promise<LyricsCandidate | null> {
  if (Date.now() < cooldownUntil) return null;

  const title = cleanLyricsTitle(hint.title);
  const artist = hint.artist.trim();
  if (!title || !artist) return null;

  const params = new URLSearchParams({ title, artist, format: "json" });
  if (hint.durationMs && hint.durationMs > 0) {
    params.set("duration", String(Math.round(hint.durationMs / 1000)));
  }

  let response: Response;
  try {
    response = await request(`${BASE}/get?${params.toString()}`, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }

  if (response.status === 429) {
    parkOnRateLimit(response);
    return null;
  }
  if (!response.ok) return null;

  try {
    return toCandidate(await response.json(), hint.durationMs);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export const lrcmuxProvider: LyricsProvider = {
  id: "LRCMUX",
  priority: 10,
  fetchLyrics: fetchLrcmuxLyrics,
};
