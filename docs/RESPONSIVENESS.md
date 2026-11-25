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

## Second pass: the clicks that were waiting on a timer

The first pass priced main-thread work and paint. This pass went looking for the
remaining delay in the interaction itself, with the click dispatched inside the
page so the measurement starts at the DOM event rather than at the automation
call.

### Every list row waited 200 ms before doing anything

`SongCardWithMenu` always passed `onDoubleClick` to `SongCard`. That put the card
on its double-click path, which holds the primary action for 200 ms in case a
second click arrives: play a track, open an artist, open an album, from search,
the library, an artist page, a collection or the queue. With the default
`trackDoubleClickBehavior: "play"` a double click runs exactly the same action as
a single one, so the wait bought nothing for most users.

The card now only passes `onDoubleClick` when the setting is `"queue"`, where the
two gestures differ. The wait stays there, and only there. `PopularTracksSection`
(the home strips) had the same timer and the same reasoning; it now plays on the
first click in `"play"` mode.

Measured on the production web build, 1440x900, guest, headless Chromium 141,
clicks dispatched in-page (three samples each, medians; the same `SongCard` backs
all of these rows):

| Interaction                          |   Before |   After |
| ------------------------------------ | -------: | ------: |
| Artist row: click -> hash change     | 215.4 ms |  5.4 ms |
| Album row: click -> hash change      | 204.5 ms |  6.4 ms |
| Artist row: click -> painted route   | ~272 ms* | 39.0 ms |
| Album row: click -> painted route    |        - | 42.6 ms |
| Play a search row: click -> mini bar | >=200 ms | 57.1 ms |
| Open fullscreen player (cold)        |  36.1 ms | 39.3 ms |
| Open fullscreen player (warm)        |  41.0 ms | 33.0 ms |

\* measured through Playwright's click, whose input pipeline adds up to a frame
or two; the before/after gap is the 200 ms timer either way.

### The search overlay stayed on top of the page it opened

Clicking an artist, album or playlist in search navigated behind the still-open
overlay, so the destination only became usable after a second click or Escape.
That is part of why navigation did not feel finished. Selecting a navigation
result now closes search; playing a track still leaves it open for browsing.

### Tried and reverted: lazy-loading the fullscreen player

`AppFrame` imported `FullscreenPlayer` statically, which pulled the `player`
chunk (968 KB raw / 249 KB gzipped) into the boot payload even though
`routes.tsx` already treated the player as a lazy route. Making the import lazy
and prefetching it once playback started only moved 7 KB gzipped off boot — the
audio engine, the store and the lyrics cache are needed by the mini player — and
the first fullscreen open went from 36 ms to **345 ms** while the already-loaded
warm open stayed at 37 ms. The module is compiled on first import and that cost
belongs on boot, not on the click. Reverted. The player chunk size is a boot
budget item, not an interaction one.

### Re-measured (no regression)

| Interaction (1440x900, production build)  |  Before |   After |
| ----------------------------------------- | ------: | ------: |
| Navigate home <-> library, click -> frame | 29.3 ms | 26.3 ms |
| Library tab switch, click -> frame        | 28.8 ms | 27.9 ms |
| Search typing, key -> frame p50           | 19.9 ms | 16.1 ms |
| Create-playlist open, click -> frame      | 45.1 ms | 27.9 ms |
| Dialog typing, key -> frame p50           | 16.9 ms | 13.4 ms |

These are at the 60 Hz headless vsync floor; the spread between runs is larger
than any change here.

### Remaining in this area

- **Daily mix cards** still hold the click for 200 ms because a single click
  opens the mix and a double click plays it. Dropping the double-click shortcut
  (the mix page has a play button) would make the first click immediate.
- **Mini player blur.** With the cover backdrop on, the embedded mini bar uses a
  48 px `backdrop-filter` over the page, and page content scrolls underneath it.
  A compositor cost cannot be measured in this VM; it is the same category as the
  dialog blur fixed earlier and should be A/B'd on the desktop build.
- **Lyrics canvas with a real stream.** The headless shell cannot demux the
  streams this VM can reach (`DEMUXER_ERROR_NO_SUPPORTED_STREAMS`), so the
  lyrics panel is still measured only by `docs/perf/lyrics-bench.html`, not by
  opening the player on a playing track.
