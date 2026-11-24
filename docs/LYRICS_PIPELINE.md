# Lyrics pipeline

Lyrics behave like the Liner API even when the app runs in a browser: several
providers compete, each answer is scored, and the best one is painted while the
others are still working. In the browser build the `/v1` endpoint is replaced by
public sources, but the event contract, ranking and player integration are the
same.

```
audio position
     │
     ▼
playerEngine.loadLyrics
     │  api.streamLyrics(id, hint)
     ▼
IS_WEB_TARGET? ── yes ──► src/web/lyrics streamLyricsEvents
     │                          │  race: LRCMUX · LRCLIB · Lyrics.ovh
     no                         ▼
     └──────────► GET /v1/tracks/:id/lyrics  (SSE)
                                │
                 provider / done events
                                ▼
             lyricsCache · lyricsStore · lyrics canvas
```

## 1. Data structures

Defined in `src/shared/contracts/lyrics.ts` and shared by the API and the
browser pipeline:

```ts
type LyricsFormat = "plain" | "lrc" | "ttml" | "qrc" | "richsync";
type LyricsSyncLevel = "plain" | "line_level" | "word_level" | "syllable_level";

interface LyricsCandidate {
  provider: string; // "LRCMUX", "LRCLIB", "Atlas"…
  lyrics: { format: LyricsFormat; content: string };
  contentKind: "plain" | "line_synced" | "word_synced" | "syllable_synced";
  syncLevel: LyricsSyncLevel;
  matchedTrack?: { title?; artists?; durationMs? };
  quality: LyricsQuality; // total + match/content/sync/source
}
```

The same objects are cached per provider (`lyricsCache`), so the provider
switcher can switch between every answer that arrived without another request.

`LyricsStreamEvent` is the wire format: `metadata`, then zero or more
`provider` events (`found` / `not_found` / `error`), then `done` with the winner.

## 2. SSE workflow

Server frames are read by `src/shared/media/sse.ts`, a small spec-shaped parser:

- frames are separated by a blank line, with `\n`, `\r\n` or `\r`;
- `data:` lines are joined with newlines, comments (`:`) are ignored;
- a final frame without a terminator is flushed when the stream closes;
- `event:` gives the frame a name, `id` and `retry` are forwarded.

`api.streamLyrics` parses each frame's JSON into a `LyricsStreamEvent` and skips
malformed frames instead of ending the stream. In the browser,
`streamLyricsEvents` produces the same events locally.

## 3. RichSync parser

`src/features/lyrics/engine/lyricsParser.ts` turns richsync JSON into the app's
synced lines:

```json
[
  {
    "ts": 28.975,
    "te": 32.958,
    "l": [
      { "c": "The ", "o": 0 },
      { "c": "morning ", "o": 0.325 }
    ]
  }
]
```

- `ts` / `te` are seconds; they become `timeMs` and `durationMs`;
- `o` is an offset from `ts`, so a line at 0.5 s with `o: 0.781` starts at
  1281 ms. Some aggregators put absolute milliseconds in `o` instead; a value
  longer than the line itself is treated as absolute;
- whitespace-only tokens are folded into the previous segment, so each word
  keeps its natural trailing space;
- every other segment is kept as a timed part, which is what makes
  syllable-level payloads work: syllables are animated one by one and can still
  be grouped back into words when a consumer needs whole words.

## 4. Word / syllable timing engine

`src/features/lyrics/engine/wordGroups.ts`:

- `mergeSyllablesIntoWords(segments, lineText)` rebuilds words from syllable
  segments by checking the line text between them (no space means the same
  word), so `morn` + `ing ` becomes `morning ` with one span from the first
  syllable's start to the last syllable's end;
- `findActiveWordIndex(words, positionMs)` binary-searches the word being sung,
  used for O(log n) position lookups instead of scanning the line every frame.

The canvas renderer (`src/features/lyrics/canvas`) consumes timed parts
directly: `buildLines` tokenizes each part, `groupTokens` keeps syllables of the
same word together, and `timing.tokenHighlight` sweeps the highlight across
each token from its own start and duration.

## 5. Centered active-word animation

The fullscreen view scrolls by line (`canvas/scrollPlan.ts` centres the active
block at 37% of the viewport) and animates the word under the playhead. For a
single-line, word-centred ticker (the touch bar / overlay layout):

1. render the active line's words in a row inside `overflow: hidden`;
2. pad the row by 50% on the right so the last word can reach the centre;
3. on each word change, translate the row by
   `containerWidth / 2 - (span.offsetLeft + span.offsetWidth / 2)`;
4. on line change, jump to the first word's offset with `transition: none`,
   then fade the row in;
5. drive it from the same clock as playback (`positionMs` extrapolated by
   `performance.now()` between updates) so it never drifts.

`findActiveWordIndex` is the lookup step; the offset math is a pure function of
layout, so it can be recomputed on resize without re-parsing lyrics.

## 6. Provider ranking

`src/web/lyrics/ranking.ts`:

- `buildQuality` scores a candidate: recording match 35%, text content 25%,
  timing 82/94/97 for line/word/syllable, source trust 15%;
- `compareCandidates` orders by timing depth first (`syllable > word > line >
plain`), then quality, then provider name for stability;
- `isDecisiveCandidate` marks a word-or-better answer with quality ≥ 70 as good
  enough to settle the race.

Completion never leaps to an early word answer while a richer tier is still in
flight. `streamLyrics.ts` tracks each provider's `maxSyncLevel`:

- if an outstanding provider can return the same or a higher tier, the race
  keeps waiting for it. Once a decisive answer is best, it waits at most the
  grace window (`DEFAULT_GRACE_MS = 800 ms`) before settling;
- if every outstanding provider is a strictly lower tier, it stops immediately
  and aborts them.

So a syllable answer arriving 900 ms after a word answer still wins; every
tier boundary (syllable > word > line > plain) holds regardless of arrival
order, and quality only decides within one tier.

`lyricsCache.compareLyricsCandidates` uses the same depth order for the cached
provider list, so what the switcher shows matches what was picked.

## 7. Fallback chain

`src/web/lyrics/streamLyrics.ts` runs the chain:

1. every `tier: "synced"` provider starts at once (LRCMUX, LRCLIB);
2. each `found` event is emitted immediately and the best candidate so far is
   tracked; a plain result never ends the race, because a timed answer may still
   arrive;
3. the race settles when no outstanding provider can match or beat the best
   tier, or when the grace window for a decisive answer expires. A settling race
   aborts the requests still in flight;
4. if no synced provider found anything, `tier: "plain"` providers run
   (Lyrics.ovh); when there is already timed text they are never asked;
5. `done` reports the winner, or `not_found` (with `instrumental` when the API
   says so).

The order is therefore syllable → word → line → plain, and the player always
receives the richest answer that arrived.

## 8. Performance

- Requests are concurrent: time to first lyrics is the fastest provider, not
  the sum of all of them.
- A decisive answer stops lower tiers immediately and waits at most the grace
  window for a possible richer one, so slow providers do not keep sockets open
  without a chance of improving the result.
- Timeouts and cancellation use `signal.ts`, which only relies on
  `AbortController`; `AbortSignal.timeout`/`any` are not required, so older iOS
  Safari builds still resolve lyrics.
- Each provider has a 9 s budget and is abortable; a dead source falls through
  instead of blocking the pipeline.
- Candidate parsing happens once per winning provider; the losing answers stay
  in the cache but are not parsed by the player.
- Word lookups are binary searches; the canvas render loop is untouched by this
  layer.

## 9. Adding a provider

Create one file in `src/web/lyrics` and register it in `lyricsProviders`. No
player, cache or UI change is needed: the race, ranking, fallback and switcher
pick it up automatically.

```ts
// src/web/lyrics/mySourceLyrics.ts
import type { LyricsCandidate } from "@/shared/contracts/lyrics";
import { buildQuality } from "./ranking";
import { cleanLyricsTitle } from "./lyricsTitle";
import type { LyricsHint, LyricsProvider } from "./types";

export async function fetchMySourceLyrics(
  hint: LyricsHint,
  signal?: AbortSignal,
): Promise<LyricsCandidate | null> {
  if (!hint.title.trim() || !hint.artist.trim()) return null;

  const url = `https://example.test/lyrics?title=${encodeURIComponent(
    cleanLyricsTitle(hint.title),
  )}&artist=${encodeURIComponent(hint.artist)}`;

  const response = await fetch(url, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { synced?: string; text?: string };
  const content = payload.synced?.trim() || payload.text?.trim();
  if (!content) return null;

  const synced = Boolean(payload.synced?.trim());
  return {
    provider: "MySource",
    lyrics: { format: synced ? "lrc" : "plain", content },
    contentKind: synced ? "line_synced" : "plain",
    syncLevel: synced ? "line_level" : "plain",
    quality: buildQuality({
      syncLevel: synced ? "line_level" : "plain",
      match: 70,
      content: 70,
      source: 55,
      reasons: ["my source"],
    }),
  };
}

export const mySourceProvider: LyricsProvider = {
  id: "MySource",
  priority: 30, // start order only; ranking picks the winner
  tier: "synced", // "plain" = asked only when nothing is timed
  maxSyncLevel: "line_level", // richest timing this source can return
  timeoutMs: 8_000, // optional, defaults to 9 s
  fetchLyrics: fetchMySourceLyrics,
};
```

Then:

```ts
// src/web/lyrics/resolveLyrics.ts
export const lyricsProviders = [
  lrcmuxProvider,
  lrclibProvider,
  mySourceProvider,
  lyricsOvhProvider,
];
```

Guidelines:

- return `null` for "nothing found" and let the race continue; throw only for
  unexpected failures (they become `error` events and do not stop the race);
- honour the abort signal so a decisive answer can cancel the request;
- only claim a sync level the payload really has — the ranker trusts it;
- reject results whose duration is seconds away from the playing track (see
  `isDifferentRecording` in `lrcmuxLyrics.ts`) instead of showing drifted lyrics;
- add a test beside the provider with a mocked `fetch` covering success, a miss,
  the exact URL and abort.

## Verification

```sh
pnpm exec tsc -b
pnpm exec vitest run src/web/lyrics src/shared/media src/features/lyrics
```
