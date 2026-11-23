import { useEffect, useMemo, useState, type RefObject } from "react";

export interface AmbientMaskSpec {
  /** 0..1 of the surface width where the left-hand fade starts. */
  fadeStart: number;
  /** 0..1 of the surface width where the fade reaches its resting alpha. */
  fadeEnd: number;
  /** Alpha the fade rests at to the right of `fadeEnd`. */
  fadeEndAlpha: number;
  /** Album-cover hole, normalised to the surface box (x/y are centres). */
  hole: { x: number; y: number; inner: number; outer: number } | null;
}

const FADE_START = 0.3;
const FADE_END = 0.62;
const FADE_END_ALPHA = 0.12;
const HOLE_SELECTOR = "[data-ambient-hole]";
const SETTLE_DELAYS_MS = [120, 450];

export const EMPTY_AMBIENT_MASK: AmbientMaskSpec = {
  fadeStart: FADE_START,
  fadeEnd: FADE_END,
  fadeEndAlpha: FADE_END_ALPHA,
  hole: null,
};

function coverHole(
  host: HTMLElement,
  hostRect: DOMRect,
): AmbientMaskSpec["hole"] {
  const hole = document.querySelector<HTMLElement>(HOLE_SELECTOR);
  if (!hole || hostRect.width <= 0 || hostRect.height <= 0) return null;
  const rect = hole.getBoundingClientRect();
  const radius = Math.max(rect.width, rect.height) / 2;
  return {
    x: (rect.left - hostRect.left + rect.width / 2) / hostRect.width,
    y: (rect.top - hostRect.top + rect.height / 2) / hostRect.height,
    inner: (radius * 1.1) / hostRect.width,
    outer: (radius * 1.75) / hostRect.width,
  };
}

/**
 * Geometry for the ambient layer's fade and cover hole. It used to be a CSS
 * `mask-image` on the host, but a mask on a full-screen canvas whose contents
 * change every frame costs a full compositor pass per frame (measured: ~17 ms
 * on an M4). The worker now bakes the same mask into its own surface with one
 * cheap `destination-in` at the effect's render scale.
 */
export function useAmbientMask(
  hostRef: RefObject<HTMLElement | null>,
): AmbientMaskSpec {
  const [hole, setHole] = useState<AmbientMaskSpec["hole"]>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHole(coverHole(host, host.getBoundingClientRect()));
    update();
    const timers = SETTLE_DELAYS_MS.map((delay) =>
      window.setTimeout(update, delay),
    );
    const observer = new ResizeObserver(update);
    observer.observe(host);
    const target = document.querySelector(HOLE_SELECTOR);
    if (target) observer.observe(target);
    window.addEventListener("resize", update);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [hostRef]);

  return useMemo(
    () =>
      hole
        ? {
            fadeStart: FADE_START,
            fadeEnd: FADE_END,
            fadeEndAlpha: FADE_END_ALPHA,
            hole,
          }
        : EMPTY_AMBIENT_MASK,
    [hole],
  );
}
