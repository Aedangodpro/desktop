import { memo, useEffect, useRef } from "react";
import { pitchShifter } from "../engine/pitchShifter";
import { usePlayerStore } from "../store/playerStore";

/**
 * A small spectrum strip fed by the AnalyserNode the effects graph already
 * owns. It draws at 30 fps from a typed array it reuses, so the canvas costs a
 * fraction of one frame per second rather than a full 60 fps redraw.
 */

const BARS = 14;
const FRAME_INTERVAL_MS = 1000 / 30;
/** Only the lower part of the spectrum carries music energy worth showing. */
const SPECTRUM_RATIO = 0.58;
const MAX_ACQUIRE_ATTEMPTS = 15;

interface VisualizerProps {
  color: string;
  className?: string;
}

export const Visualizer = memo(function Visualizer({
  color,
  className,
}: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const status = usePlayerStore((state) => state.status);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };

    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const clear = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
    };

    // Hidden by the container query on narrow windows: keep the effects graph
    // (and its AudioContext) out of the path when nothing would be drawn.
    if (status !== "playing" || canvas.clientWidth === 0) {
      clear();
      return;
    }

    // The effects graph is built lazily, and with no pitch/reverb/EQ on it is
    // never built at all. Attach it here so the visualizer has an analyser to
    // read; the controller shares the one graph and context.
    if (!pitchShifter.getAnalyser()) {
      const audio = (window as unknown as { __liner_audio?: HTMLAudioElement })
        .__liner_audio;
      if (audio) pitchShifter.attach(audio);
    }

    let analyser = pitchShifter.getAnalyser();
    let bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    let acquireAttempts = 0;
    let acquireTimer: ReturnType<typeof setTimeout> | null = null;
    let frameId = 0;
    let lastDrawnAt = 0;

    const acquire = () => {
      if (analyser) return true;
      analyser = pitchShifter.getAnalyser();
      if (!analyser) {
        if (acquireAttempts >= MAX_ACQUIRE_ATTEMPTS) return false;
        acquireAttempts += 1;
        acquireTimer = setTimeout(acquire, 200);
        return false;
      }
      bins = new Uint8Array(analyser.frequencyBinCount);
      return true;
    };

    const draw = (now: number) => {
      frameId = requestAnimationFrame(draw);
      if (now - lastDrawnAt < FRAME_INTERVAL_MS) return;
      lastDrawnAt = now;
      if (document.hidden) return;
      if (!acquire() || !analyser || !bins) return;

      analyser.getByteFrequencyData(bins);

      const { width, height } = canvas;
      context.clearRect(0, 0, width, height);
      const usableBins = Math.max(
        BARS,
        Math.floor(bins.length * SPECTRUM_RATIO),
      );
      const slotWidth = width / BARS;
      const gap = Math.max(1, slotWidth * 0.3);
      const barWidth = Math.max(1, slotWidth - gap);
      context.fillStyle = color;

      for (let bar = 0; bar < BARS; bar += 1) {
        const start = Math.floor((bar / BARS) * usableBins);
        const end = Math.max(
          start + 1,
          Math.floor(((bar + 1) / BARS) * usableBins),
        );
        let sum = 0;
        for (let index = start; index < end; index += 1) {
          sum += bins[index];
        }
        const level = sum / (end - start) / 255;
        const barHeight = Math.max(2, level * height);
        const x = bar * slotWidth + gap / 2;
        const y = height - barHeight;

        context.globalAlpha = 0.4 + level * 0.6;
        context.beginPath();
        if (typeof context.roundRect === "function") {
          context.roundRect(x, y, barWidth, barHeight, barWidth / 2);
        } else {
          context.rect(x, y, barWidth, barHeight);
        }
        context.fill();
      }
      context.globalAlpha = 1;
    };

    frameId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frameId);
      if (acquireTimer !== null) clearTimeout(acquireTimer);
      clear();
    };
  }, [status, color]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      data-testid="player-visualizer"
    />
  );
});
