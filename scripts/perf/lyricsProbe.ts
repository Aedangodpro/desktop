/**
 * Runtime benchmark for the canvas lyrics renderer.
 *
 * Mounts the real `LyricsCanvasRenderer` against word-level lyrics and keeps
 * the song "playing" so the live line animates every frame, which is the
 * heaviest state the renderer ever draws. The page reports rAF cadence plus the
 * canvas calls the renderer makes per frame, so a change can be measured
 * instead of guessed at.
 *
 * Open `/docs/perf/lyrics-bench.html` on the web dev server and read `window.probe` or the
 * overlay in the bottom-left corner.
 */
import { LyricsCanvasRenderer } from "/src/features/lyrics/canvas/lyricsCanvasRenderer";

const LINE_COUNT = 60;
const WORDS_PER_LINE = 8;
const WORD_MS = 320;
const LINE_MS = WORDS_PER_LINE * WORD_MS + 400;
const SAMPLE_MS = 4000;

interface LyricPart {
  startTimeMs: number;
  words: string;
  durationMs: number;
}

function makeLyrics(): unknown[] {
  const lines = [];
  let start = 0;
  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const parts: LyricPart[] = [];
    for (let word = 0; word < WORDS_PER_LINE; word++) {
      parts.push({
        startTimeMs: start + word * WORD_MS,
        words: word === 0 ? `Line ${lineIndex}` : `word${word}`,
        durationMs: WORD_MS,
      });
    }
    lines.push({
      startTimeMs: start,
      durationMs: LINE_MS,
      words: parts.map((part) => part.words).join(" "),
      parts,
      agent: "v1000",
    });
    start += LINE_MS;
  }
  return lines;
}

const counts = { fillText: 0, gradient: 0, drawImage: 0, clearRect: 0 };
let counting = false;

const proto = CanvasRenderingContext2D.prototype;
const originalFillText = proto.fillText;
const originalGradient = proto.createLinearGradient;
const originalDrawImage = proto.drawImage;
const originalClearRect = proto.clearRect;

proto.fillText = function patchedFillText(
  ...args: Parameters<CanvasRenderingContext2D["fillText"]>
) {
  if (counting) counts.fillText += 1;
  return originalFillText.apply(this, args);
};
proto.createLinearGradient = function patchedCreateLinearGradient(
  ...args: Parameters<CanvasRenderingContext2D["createLinearGradient"]>
) {
  if (counting) counts.gradient += 1;
  return originalGradient.apply(this, args);
};
proto.drawImage = function patchedDrawImage(
  ...args: Parameters<CanvasRenderingContext2D["drawImage"]>
) {
  if (counting) counts.drawImage += 1;
  return originalDrawImage.apply(this, args);
};
proto.clearRect = function patchedClearRect(
  ...args: Parameters<CanvasRenderingContext2D["clearRect"]>
) {
  if (counting) counts.clearRect += 1;
  return originalClearRect.apply(this, args);
};

const host = document.getElementById("host") as HTMLDivElement;
const stage = document.getElementById("stage") as HTMLDivElement;

const mainCanvas = document.createElement("canvas");
mainCanvas.style.position = "absolute";
mainCanvas.style.inset = "0";
mainCanvas.style.width = "100%";
mainCanvas.style.height = "100%";
const liveCanvas = document.createElement("canvas");
liveCanvas.style.position = "absolute";
liveCanvas.style.top = "0";
liveCanvas.style.left = "0";
liveCanvas.style.width = "100%";
stage.appendChild(mainCanvas);
stage.appendChild(liveCanvas);

let nowMs = 0;
const renderer = new LyricsCanvasRenderer(
  mainCanvas,
  liveCanvas,
  {
    timeMs: () => nowMs,
    playing: () => true,
  },
  () => {},
);

renderer.setLyrics(makeLyrics() as never);
renderer.resize(640, 720, 2);

function frames(): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = 0;
    const started = performance.now();
    const tick = (now: number) => {
      if (last) deltas.push(now - last);
      last = now;
      if (now - started < SAMPLE_MS) {
        requestAnimationFrame(tick);
        return;
      }
      resolve(deltas);
    };
    requestAnimationFrame(tick);
  });
}

function stats(deltas: number[]) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  return {
    samples: deltas.length,
    medianMs: Number(at(0.5).toFixed(2)),
    p95Ms: Number(at(0.95).toFixed(2)),
    fps: Number((deltas.length / (SAMPLE_MS / 1000)).toFixed(1)),
  };
}

export interface ProbeResult {
  cadence: ReturnType<typeof stats>;
  perFrame: Record<string, number>;
}

async function run(): Promise<ProbeResult> {
  await document.fonts.ready;
  nowMs = 1000;
  // warm the bitmaps and the layout up
  renderer.invalidate();
  await frames();

  counting = true;
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    counts[key] = 0;
  }
  const started = performance.now();
  nowMs += SAMPLE_MS;
  const deltas = await frames();
  const elapsedFrames = deltas.length || 1;
  counting = false;
  void started;

  const perFrame: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    perFrame[key] = Number((value / elapsedFrames).toFixed(2));
  }

  return { cadence: stats(deltas), perFrame };
}

const log = document.getElementById("log") as HTMLDivElement;

void run().then((result) => {
  (window as unknown as { probe: ProbeResult }).probe = result;
  log.textContent =
    `fps ${result.cadence.fps}  median ${result.cadence.medianMs}ms  ` +
    `p95 ${result.cadence.p95Ms}ms\n` +
    Object.entries(result.perFrame)
      .map(([key, value]) => `${key}/frame ${value}`)
      .join("  ");
});
