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

// Query params let the probe be pointed at the size the player actually draws:
// `?w=1150&h=1400&dpr=1.5&wordMs=1800&instrumental=1`. The defaults keep the
// original small fixture, so existing numbers stay comparable.
const params = new URLSearchParams(location.search);
const number = (name: string, fallback: number) => {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const LINE_COUNT = number("lines", 60);
const WORDS_PER_LINE = number("words", 8);
const WORD_MS = number("wordMs", 320);
// A token longer than 1.5 s animates the glow, which paints through
// `shadowBlur` — the costliest call the renderer makes.
const LONG_WORD_MS = number("longMs", WORD_MS);
// Instrumental lines draw a clipped, glowing note every frame.
const INSTRUMENTAL_EVERY = number("instrumental", 0);
const LINE_MS =
  (WORDS_PER_LINE - 1) * WORD_MS + Math.max(WORD_MS, LONG_WORD_MS) + 400;
const SAMPLE_MS = number("sampleMs", 4000);

interface LyricPart {
  startTimeMs: number;
  words: string;
  durationMs: number;
}

function makeLyrics(): unknown[] {
  const lines = [];
  let start = 0;
  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    if (INSTRUMENTAL_EVERY > 0 && lineIndex % INSTRUMENTAL_EVERY === 0) {
      lines.push({ startTimeMs: start, durationMs: LINE_MS, words: "" });
      start += LINE_MS;
      continue;
    }
    const parts: LyricPart[] = [];
    for (let word = 0; word < WORDS_PER_LINE; word++) {
      parts.push({
        startTimeMs: start + word * WORD_MS,
        words: word === 0 ? `Line ${lineIndex}` : `word${word}`,
        durationMs: word === WORDS_PER_LINE - 1 ? LONG_WORD_MS : WORD_MS,
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
const CANVAS_WIDTH = number("w", 640);
const CANVAS_HEIGHT = number("h", 720);
const DPR = number("dpr", 2);
host.style.width = `${CANVAS_WIDTH}px`;
host.style.height = `${CANVAS_HEIGHT}px`;

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
renderer.resize(CANVAS_WIDTH, CANVAS_HEIGHT, DPR);

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
