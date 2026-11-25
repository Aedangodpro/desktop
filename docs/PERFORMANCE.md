# Player performance

The player composites several animated surfaces at once. This note records what
each one costs, what was measured, and what is still unmeasured.

## What a player frame is made of

| Layer                              | Where                                   | Cadence before | Cadence now                  |
| ---------------------------------- | --------------------------------------- | -------------- | ---------------------------- |
| Album-colour warp (WebGL)          | `engine/kawarpEngine.ts`                | 30 fps, fixed  | display, or half in balanced |
| Ambient background (worker canvas) | `hooks/useAmbientWorker.ts`             | 30 fps         | 30 fps                       |
| Lyrics canvas                      | `lyrics/canvas/lyricsCanvasRenderer.ts` | on demand      | on demand                    |
| Edge blur bands over the lyrics    | `player/ui/CanvasLyricsView.tsx`        | full visuals   | 56/72 px, masked             |
| Notch glass (`backdrop-blur-2px`)  | `shared/ui/Notch.tsx`                   | full visuals   | static fill                  |
| Page cover backdrop (`blur(56px)`) | `navigation/ui/PageCoverBackdrop.tsx`   | static image   | static image                 |

Only the warp actually stepped at 30 fps, but it is the largest moving surface
on screen, so it is the one that made playback read as "30 fps" while the lyrics
and the UI ran at the display rate. Full visuals now draw every refresh, and the
balanced mode draws half of the display rate: 30 on a 60 Hz panel, 60 on 120 Hz,
72 on 144 Hz, 100 on 200 Hz. Half is still the cheaper cadence, but it stays in
step with the refresh instead of beating against it.

The rate is measured rather than assumed, because the browser exposes no
refresh-rate API. `hooks/useDisplayRefreshRate.ts` samples rAF once per session
for 500 ms, takes the fastest sustained interval (a single hitch must not halve
the estimate), and snaps the result to the panel it belongs to (59.94 → 60,
143.6 → 144, 199.4 → 200). An unusual panel keeps its measured rate. Until the
sample lands — or while the page is hidden, where rAF is throttled — the 60 Hz
fallback applies.

Frame pacing is not "wait a whole interval": on a 144 Hz display a 16.7 ms
interval falls between two and three refresh slots and a whole-interval wait
lands on 48 fps (`isFrameDue`, tested in `kawarpPacing.test.ts`).

## Route changes

Measured on the production web build (headless Chromium, 1440×900, guest
content) with a long-animation-frame observer plus a DevTools timeline trace:
click to the first presented frame of the new route is 25–28 ms, no frame in
the window passed 50 ms, and the trace totals ~5 ms of layout against ~24 ms of
script. The script is React re-rendering the shell and revealing the page's
deferred Activity work, not a data refetch.

What still read as lag was presentation. Both kept pages replayed the 200 ms
`page-enter` animation every time `Activity` showed them, because leaving
`display: none` restarts CSS animations. The incoming page therefore painted at
opacity 0 for its first two or three frames and only reached opacity 1 at
~220 ms after the click. Kept pages now switch with no entry animation — they
are already mounted and current — while routes that actually mount keep the
rise and fade, where it covers the first paint instead of delaying it.

The trace cannot price paint or GPU work: headless Chromium has no compositor
surface, so `Rasterize` stays at 0 ms. A slow `backdrop-filter` or a large blur
on a real display would not appear in these numbers.

## Canvas lyrics benchmark

`docs/perf/lyrics-bench.html` + `scripts/perf/lyricsProbe.ts` mount the real
`LyricsCanvasRenderer` with word-level lyrics and keep the song "playing" so the
live line animates every frame. Run the web dev server and open
`/docs/perf/lyrics-bench.html`; the page exposes `window.probe` and prints its result.

Measured in headless Chromium through CDP (640×720 at dpr 2, 4 s sample,
software rasterisation, so the absolute milliseconds are not a GPU figure — the
per-frame canvas calls and the relative change are):

| Per frame              | Before | After |
| ---------------------- | -----: | ----: |
| `fillText` calls       |  17.15 | 10.12 |
| `createLinearGradient` |   3.01 |  1.01 |
| `drawImage` calls      |   6.88 |  8.89 |
| `clearRect` calls      |   2.02 |  2.02 |

What changed:

- a token that has been swept completely is painted edge to edge by its
  highlight, so the muted base pass under it is skipped — one text draw less per
  sung word (`canvas/drawWord.ts`);
- the white alpha strings are interned per quantised alpha instead of formatted
  per token per frame;
- the edge fog is one cached strip stretched into place instead of a new
  `CanvasGradient` per tweening frame (`canvas/edgeFog.ts`) — that is where the
  two extra `drawImage` calls come from;
- the bitmap bookkeeping reuses one `Set`, and the lit-token cache key counts in
  a loop instead of allocating a filtered array per line per frame.

The renderer's own JS self time in a 3 s profile fell from ~23 ms to ~13 ms; the
remaining cost is canvas rasterisation of the text bitmaps, not scripting.

## High-refresh displays

Two per-frame costs grew with the panel instead of with what changes on screen:

- **The live lyric line was re-rasterised every frame.** The bitmap key in
  `canvas/sceneLines.ts` was the rAF timestamp, so a 200 Hz panel rebuilt the
  karaoke line's text bitmap 200 times a second. The key is now bucketed at
  `LIVE_BITMAP_BUCKET_MS = 8`: at most 125 rebuilds a second, about 100 on a
  200 Hz panel, and unchanged at 60 Hz where frames are already further apart.
  The canvas still presents every refresh — only the expensive text raster is
  reused between frames, and the sweep edge moves under a pixel in 8 ms.
- **The adaptive quality guard was blind above 60 Hz.** `isStrained` compared
  the median frame time with a fixed 24 ms, so a 200 Hz panel running at
  80–120 fps looked healthy next to it and never stepped the effects down —
  which is exactly the case that reads as laggy. The steady-cadence threshold
  is now `min(24 ms, 1.5 × refresh interval)` (7.5 ms at 200 Hz), using the
  panel rate from `useDisplayRefreshRate()`. The late-frame test keeps its
  60 Hz floor, so an occasional doubled refresh is still not a downgrade.

## React and background work

- Timeline updates arrive from the audio element's `timeupdate` (roughly 4 per
  second), not from a frame loop, so the mini player and the timeline re-render a
  few times a second during playback.
- `FrameLoop` stops scheduling when the lyrics canvas is off screen or the
  window is hidden, and only polls every 50 ms when nothing is animating.
- The ambient effect runs in a worker, stops while paused and while off screen,
  and renders at most 30 fps at half resolution; its CSS blur is dropped below
  4 px and the softening is folded into the render scale instead.
- `useAdaptiveVisuals` samples frame deltas for 3 s every 10 s and steps the
  visual mode down one level after two strained windows. It only lowers the
  session mode, never the saved preference.

## `backdrop-filter` above a moving surface

The player's chrome floats over the warp. A `backdrop-filter` on one of those
panels is not a one-off: the compositor has to copy and blur the backdrop again
on every frame the surface under it changes, and in the fullscreen player that
surface changes at the display rate. The chrome is small, so the cost is easy to
miss in a still screenshot and easy to feel while a song plays, and it is the
one cost that grows with the monitor while the work behind it stays the same.

The expensive version of this was the two **full-height** edge bands over the
lyrics, at 18%/26% of the viewport: ~17 ms per frame. At their present 56 px and
72 px, with the mask fading the blur out before the band ends, the cost is in
the noise — so they stay, because that soft edge is the effect people notice.
The 2 px notch blur and the `backdrop-blur-xl` on the like button are gone in
favour of static translucency, where nobody can tell the difference and the
panel sits over the moving background the whole time.

`playerSurfaces.test.ts` keeps the notch and the like button free of
`backdrop-filter`, and pins the lyrics bands to their small heights so they
cannot grow back into the measured-expensive range.

A machine can also be fast and still rasterise on the CPU: driver blocklists and
a switched-off "use hardware acceleration" setting both do it. `isSoftwareGpu()`
(`shared/lib/deviceTier.ts`) now starts those machines in `lite` instead of
`balanced`, because the warp, the ambient canvas and the lyrics are all their
CPU's problem in that state.

## Dialog input latency

Dialogs were the slowest interaction in the app. On the production web build at
1440x900 (guest), opening the create-playlist dialog took **218.5 ms** from
click to the next presented frame, and typing in its title field cost **84.6 ms
p50 / 118.3 ms p95** per keystroke. Event Timing recorded no long tasks; LoAF
recorded 18 frames up to 207 ms with zero blocking time, which puts the cost in
paint/composite rather than JavaScript.

The cause was two `backdrop-filter` layers over the page: the full-screen scrim
(`backdrop-blur-[2px]`, over `bg-black/15`) and the dialog panel
(`backdrop-blur-2xl`). Every change inside the panel forced the compositor to
re-blur the whole page behind it. Isolating them: 63.3 ms per key with both,
23.9 ms with only the scrim blur removed, 50.4 ms with only the panel blur
removed, 11.8 ms with neither.

Both layers are gone from `Dialog`. The panel keeps `bg-surface-glass`, which is
90–92% opaque, so the blur was barely visible; the 2 px scrim blur was invisible
entirely. `dialogSurfaces.test.ts` keeps them from coming back.

| Interaction (1440x900, production build) |          Before |   After |
| ---------------------------------------- | --------------: | ------: |
| Dialog open, click → next frame          |        218.5 ms | 27.9 ms |
| Keystroke in dialog, p50                 |         84.6 ms | 16.8 ms |
| Keystroke in dialog, p95                 |        118.3 ms | 33.3 ms |
| Slow animation frames (LoAF)             | 18 (max 207 ms) |       0 |

Signed-out library visits also requested `GET /v1/me/library/{albums,artists,playlists}`
and collected three 401s each time, because saved collections are account data
with no local fallback. `useExternalItems` now takes `enabled` from
`useSessionSignedIn()`, so those requests only happen with a session. Over the
same three-round-trip navigation measurement the request count fell from 9 to 1.

Route changes (27.3 ms p50 click → next frame), library tab switches (27.5 ms)
and search typing (16.2 ms p50 key → next frame) were re-measured and are
unchanged: those numbers are at the 60 Hz headless vsync floor, not a render
cost. The fullscreen player and its lyrics view could not be measured in this
environment without a signed-in stream; the mount is a separate open item.

## Measured on this pass

`scripts/perf/lyricsProbe.ts` now takes the canvas size and the lyric shape from
its query string (`?w=1150&h=1400&dpr=1.5&wordMs=320&longMs=1800&instrumental=4`),
so the probe can be pointed at the box the player actually draws. At 1700×1400
at dpr 2 with glow words and instrumental lines, the renderer's scripting cost
is ~0.3 ms per frame (`FireAnimationFrame` 55 ms across a 3 s trace, two rAF
loops), so the canvas is not what a fast machine is waiting on. Headless
Chromium does not rasterise or composite the page, so paint and GPU cost still
cannot be measured here; that is exactly why the fix above targets the one
category that is known to be expensive per frame regardless of GPU speed.

## Still unmeasured here

- **Transparent Electron window.** `electron/main.ts` creates the main window
  with `transparent: true`. On Windows that takes the window off the normal
  compositing path (layered window, DWM blends the page every frame), which is a
  common cause of a whole-app frame ceiling on fast hardware. This predates the
  recent player work, but it cannot be measured from a browser or a headless VM.
  Setting `transparent: false` with an opaque `backgroundColor` is the experiment
  that settles it; it changes how the rounded window corners look on Windows.
- **GPU cost of the stacked surfaces.** The warp target, the ambient canvas and
  the lyrics canvas are all live at once in the fullscreen player. Only the
  software-raster numbers above were measurable in this environment.
