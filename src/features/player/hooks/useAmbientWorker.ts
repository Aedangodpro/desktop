import { useEffect, useRef, type RefObject } from "react";
import { buildAmbientWorkerSource } from "@/shared/media/ambient";
import { log } from "@/shared/utils/logger";
import { observeElementVisible } from "@/shared/utils/elementVisibility";
import { playbackState, startAmbientFeed } from "./ambientFeed";
import type { AmbientMaskSpec } from "./useAmbientMask";

const DEFAULT_SCALE = 0.5;
const DEFAULT_BLUR_PX = 1.5;

/**
 * A CSS `blur()` on this layer is a full-screen filter pass every frame, which
 * measured ~33 ms per frame on top of the WebGL background. The default blur is
 * a 1.5 px softening of art that is already rendered at half size, so a lower
 * render scale gives the same look without the compositor pass. Effects that
 * ask for a real blur (>= 4 px) keep it.
 */
export const AMBIENT_CSS_BLUR_MIN_PX = 4;
export const AMBIENT_BLUR_SOFTEN_SCALE = 0.8;

export function ambientRenderScale(
  requested: number | undefined,
  blur: number | undefined,
): number {
  const scale = clampScale(requested);
  if (!blur || blur >= AMBIENT_CSS_BLUR_MIN_PX) return scale;
  return scale * AMBIENT_BLUR_SOFTEN_SCALE;
}

export function ambientCssBlur(blur: number | undefined): string | undefined {
  return blur && blur >= AMBIENT_CSS_BLUR_MIN_PX ? `blur(${blur}px)` : undefined;
}

export interface AmbientOptions {
  pixelated: boolean;
  blur: number;
}

interface WorkerMessage {
  type: string;
  message?: string;
  pixelated?: boolean;
  scale?: number;
  blur?: number;
}

function surfaceSize(canvas: HTMLCanvasElement, scale: number) {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
}

const clampBlur = (blur: number | undefined) =>
  typeof blur === "number" && Number.isFinite(blur)
    ? Math.min(24, Math.max(0, blur))
    : DEFAULT_BLUR_PX;

const clampScale = (scale: number | undefined) =>
  scale && scale > 0 ? Math.min(1, Math.max(0.05, scale)) : DEFAULT_SCALE;

export function useAmbientWorker(
  hostRef: RefObject<HTMLDivElement | null>,
  pixelated: boolean,
  script: string | null,
  mask: AmbientMaskSpec,
  onFailure: () => void,
  onOptions: (options: AmbientOptions) => void,
) {
  const workerRef = useRef<Worker | null>(null);
  const maskRef = useRef(mask);
  maskRef.current = mask;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !script) return;
    const canvas = document.createElement("canvas");
    canvas.className = "block h-full w-full";
    host.replaceChildren(canvas);

    const source = URL.createObjectURL(
      new Blob([buildAmbientWorkerSource(script)], {
        type: "text/javascript",
      }),
    );
    const worker = new Worker(source);
    workerRef.current = worker;
    let scale = DEFAULT_SCALE;
    let blur: number | undefined;
    const resize = () =>
      worker.postMessage({
        type: "resize",
        ...surfaceSize(canvas, ambientRenderScale(scale, blur)),
      });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === "options") {
        scale = clampScale(event.data.scale);
        blur = clampBlur(event.data.blur);
        onOptions({
          pixelated: Boolean(event.data.pixelated),
          blur,
        });
        resize();
        return;
      }
      if (event.data.type !== "error") return;
      log("yellow", "ambient", `effect stopped: ${event.data.message}`);
      worker.terminate();
      onFailure();
    };
    worker.onerror = () => {
      worker.terminate();
      onFailure();
    };

    const size = surfaceSize(canvas, scale);
    const offscreen = canvas.transferControlToOffscreen();
    offscreen.width = size.width;
    offscreen.height = size.height;
    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        info: { ...size, state: playbackState() },
        mask: maskRef.current,
      },
      [offscreen],
    );

    let visible = true;
    const feed = startAmbientFeed(worker, () => visible);
    const stopObserving = observeElementVisible(host, (next) => {
      visible = next;
      feed.refresh();
    });
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    return () => {
      stopObserving();
      feed.stop();
      resizeObserver.disconnect();
      worker.terminate();
      workerRef.current = null;
      URL.revokeObjectURL(source);
      canvas.remove();
    };
  }, [hostRef, script, onFailure, onOptions]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "mask", mask });
  }, [mask]);

  useEffect(() => {
    const canvas = hostRef.current?.firstElementChild;
    if (canvas instanceof HTMLCanvasElement) {
      canvas.style.imageRendering = pixelated ? "pixelated" : "";
    }
  }, [hostRef, pixelated]);
}
