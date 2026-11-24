# Responsiveness: clicks, typing, and the playback fallback chain

The first performance pass (`docs/PERFORMANCE.md`) was about frames: what the
player paints, and how often. This one is about the other half of how the app
feels — the time between a click, a keystroke or a track change and the UI
reacting — and about the network work that competes with it.

The symptoms were "buttons feel slower than expected", "the lyrics view takes a
moment to open", "typing lags", plus a console export showing one unplayable
track walking a very long provider chain and signed-out visitors hitting
`/v1/me/history` and `/v1/me/recommendations`.

## What was measured

Main-thread cost, in this VM, with `src/shared/media/search/matchingCost.test.ts`
(warm runs, median of 12; not a GPU figure, but these are all CPU):

| Path                                          |   Before |   After |
| --------------------------------------------- | -------: | ------: |
| Match 100 SoundCloud fallback candidates      |  2.08 ms | 0.97 ms |
| Merge 20 SoundCloud hits into 25 catalog hits | 29.57 ms | 5.38 ms |
| Score 40 search hits for relevance            |  0.49 ms | 0.39 ms |

Run it with `npx vitest run src/shared/media/search/matchingCost.test.ts`; the
bounds in the test only catch an order-of-magnitude regression.

## Root causes

### 1. Catalog search waited for the second catalog before painting

`api.search` merged SoundCloud hits into the catalog answer before returning, and
the SoundCloud lookup has a 2.5 s timeout. Typing in the search bar debounced for
320 ms, then waited for both sources: the first result could not appear until the
slower of the two answered. On top of that, every keystroke left the previous
lookup running — nothing passed an abort signal — so stale searches kept using
the relay while the new one queued behind them.

`withSoundCloudTracks` now reports the catalog answer through `onPrimary` as soon
as it settles (`shared/api/catalogSearch.ts`), and the search hooks paint it
immediately (`features/search/hooks/useSearchAll.ts`, `useSearchTracks.ts`). The
merge lands a moment later and replaces the list. Each new query aborts the
previous lookup.

### 2. The SoundCloud merge was quadratic in result count

`mergeSoundCloudTracks` compared every SoundCloud candidate against every catalog
track — each comparison re-parsed and re-normalised both titles and ran artist
matching with a phonetic transliteration. 20 × 25 hits meant roughly 500
comparisons and cost ~30 ms of main thread, synchronously, at the exact moment
the results were about to render.

Two changes (`shared/media/search/mergeSoundCloudTracks.ts`,
`shared/media/matching/memo.ts`):

- tracks are indexed by title word, so a candidate is compared with the handful
  of hits that share a word instead of all of them (two titles cannot be the same
  recording without sharing a word);
- the pure normalisers (`cleanBaseTitle`, `stripJunk`, `normalizeWords`,
  `toPhoneticLatin`) are memoised with a bounded cache, because the same strings
  were normalised hundreds of times per search.

This is the change behind the 29.6 → 5.4 ms row above.

### 3. A failed track walked the whole chain again, every time

`resolveYoutubeVideoWithStandIn` is thorough by design: a refused video gets a
catalog search, two raw searches, up to three replacement resolves, a SoundCloud
search and up to three SoundCloud resolves. That is fine once. It was not fine
that a track that had just failed did it again on:

- the runtime's own recovery reload (`loadAndPlay(track, pos, true)`),
- a skip back to the track,
- a second click on the play button,
- a speculative preload that failed for its own reasons.

That is the "very large fallback chain" in the console: several chains for one
track. `resolvePlaybackStream` now remembers a failed resolution for 45 s
(`features/player/engine/streamResolver.ts`) and rethrows the same error without
touching a provider. A success clears the entry; preloads pass
`recordFailure: false`, so a speculative warm-up can never blacklist a track.

### 4. The SoundCloud search ran eagerly, even when a re-upload played

The other catalog was searched in parallel with the replacement probes on every
refusal, then aborted if a replacement worked. Two deep searches (50 hits each,
two queries) were sent and thrown away for the common case. It is now started
eagerly only when every YouTube client was refused — the case where it is the
only source that can answer — and lazily after the replacement probes otherwise.

The fallback search itself is now tiered (`soundcloudFallback.ts`): the first
pass asks for 20 hits per query and only an empty result pays for the deep 50-hit
pass. Matching is capped at 80 candidates and rejection logging at 10 lines plus
a count, so a track with 88 hits no longer prints 88 lines to the console.

### 5. Signed-out visitors called per-account endpoints

`useDailyMixes` and `useRecentlyPlayed` loaded unconditionally, so a signed-out
home visit sent `GET /v1/me/recommendations/daily-mixes` and
`GET /v1/me/history`, collected two 401s, and retried the home feed's loading
state for them. Playback telemetry (`POST /v1/me/playback/events`) did the same
per track with no session.

`useCachedResource` gained an `enabled` policy flag
(`shared/cache/useCachedResource.ts`); the two home resources pass
`enabled: signedIn` (`useSessionSignedIn` in `features/home/hooks/sessionAwareLoad.ts`)
and playback events are skipped when there is no access token
(`playerEngine.ts`). Signing in changes the cache key, so the first signed-in
visit still loads the real data.

### 6. Whole-store subscriptions in the player chrome

`FullscreenPlayer` and `LyricsProviderIsland` read the entire lyrics store, so
every lyrics field change re-rendered the component that owns the WebGL warp, the
ambient layer and the lyrics canvas. Both now select only the fields they use.

## Future-proofing

- **Many SoundCloud results** — first page of 20, deepening only when nothing
  matched, at most 80 candidates, bounded console output.
- **Failed YouTube resolutions** — one chain per track per 45 s, shared by the
  recovery reload, manual retries and preloads.
- **Slow providers** — catalog results paint before the second catalog, and the
  merge replaces the list when it lands; stale searches are aborted by query.
- **Large queues / radio** — unchanged here: radio refills one track ahead
  (`shouldRefillRadio`), dedupes against the current queue, and shares one
  in-flight request (`radioFetchInFlight`).
- **Signed-out users** — per-account resources are gated on the session instead
  of collecting 401s.

## What is verified by tests

- `matchingCost.test.ts` — the CPU costs above, with loose regression bounds.
- `catalogSearch.test.ts` — the catalog answer reaches the UI before the
  SoundCloud lookup settles, and an aborted query starts no lookup.
- `resolveFailureMemo.test.ts` — a track that just failed is not re-walked, a
  success clears the memory, and a speculative preload cannot poison a play.
- `soundcloudFallback.test.ts` — first pass at 20 hits per query, the deep pass
  only when the first found nothing.
- `useDailyMixes.signedOut.test.tsx` — no per-account request without a session.
- `useDailyMixes.account.test.tsx`, `useRecentlyPlayed.test.tsx`,
  `playerSignOut.test.ts` — the signed-in paths still load and report.

## What is not measured here

- **Click-to-paint, end to end.** No browser could run in this environment: the
  cloud browser never became available, and a downloaded headless Chromium could
  not start because the image is missing its desktop libraries with no root to
  install them. So the latency of a real click or keystroke in a real renderer
  was not timed. What is measured is the main-thread work each interaction does,
  which is the part these fixes changed.
- **Click-to-paint on the real desktop build.** The felt latency of a button in
  Electron also includes the window compositing path recorded as unmeasured in
  `docs/PERFORMANCE.md` (`transparent: true`), which no browser run can
  reproduce either.
- **A signed-in session.** Lyrics, likes and per-account feeds need an account;
  only the signed-out paths can be exercised here.
- **Provider latency itself.** The fixes bound the work around a slow provider;
  they do not make YouTube or SoundCloud answer sooner.
