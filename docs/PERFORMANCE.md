# Player performance

The player composites several animated surfaces at once. This note records what
each one costs, what was measured, and what is still unmeasured.

## What a player frame is made of

| Layer                              | Where                                   | Cadence before | Cadence now       |
| ---------------------------------- | --------------------------------------- | -------------- | ----------------- |
| Album-colour warp (WebGL)          | `engine/kawarpEngine.ts`                | 30 fps, fixed  | display rate, ≤60 |
| Ambient background (worker canvas) | `hooks/useAmbientWorker.ts`             | 30 fps         | 30 fps            |
| Lyrics canvas                      | `lyrics/canvas/lyricsCanvasRenderer.ts` | on demand      | on demand         |
| Edge blur bands over the lyrics    | `player/ui/CanvasLyricsView.tsx`        | full visuals   | full visuals      |
| Notch glass (`backdrop-blur-2px`)  | `shared/ui/Notch.tsx`                   | full visuals   | full visuals      |
| Page cover backdrop (`blur(56px)`) | `navigation/ui/PageCoverBackdrop.tsx`   | static image   | static image      |

Only the warp actually stepped at 30 fps, but it is the largest moving surface
on screen, so it is the one that made playback read as "30 fps" while the lyrics
and the UI ran at the display rate. It now follows the display up to 60 fps in
the full visual mode and keeps 30 fps in the balanced mode, where the cheaper
cadence is the point.

Frame pacing is not "wait a whole interval": on a 144 Hz display a 16.7 ms
interval falls between two and three refresh slots and a whole-interval wait
lands on 48 fps (`isFrameDue`, tested in `kawarpPacing.test.ts`).

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
