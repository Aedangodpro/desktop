import { useEffect, useRef, useState, type RefObject } from "react";
import type { Lyric } from "@braccato/parsers";
import { LyricsCanvasRenderer } from "@/features/lyrics";
import { usePlayerStore } from "../store/playerStore";
import { playerEngine } from "../engine/playerEngine";
import { observeElementVisible } from "@/shared/utils/elementVisibility";
import { shouldReleaseTopPin, startsPinnedToTop } from "../ui/lyricsTopPin";
import { audioElement, createMediaClock } from "./mediaClock";
import { snapStage } from "./pixelSnap";

// The stage is a canvas that fills the host, so the ResizeObserver already
// covers ordinary resizes. This slow poll only catches device-pixel-ratio and
// zoom changes, and every tick costs a forced layout.
const SNAP_CHECK_MS = 1000;

export interface ScrollEdges {
  atTop: boolean;
  atBottom: boolean;
}

export interface LyricsCanvasHandle {
  rendererRef: RefObject<LyricsCanvasRenderer | null>;
  edges: ScrollEdges;
  releasePin: () => void;
}

export interface LyricsCanvasRefs {
  host: RefObject<HTMLDivElement | null>;
  stage: RefObject<HTMLDivElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  live: RefObject<HTMLCanvasElement | null>;
}

export function useLyricsCanvas(
  refs: LyricsCanvasRefs,
  lyrics: Lyric[],
  fogEnabled: boolean,
): LyricsCanvasHandle {
  const rendererRef = useRef<LyricsCanvasRenderer | null>(null);
  const pinnedRef = useRef(false);
  const [edges, setEdges] = useState<ScrollEdges>({
    atTop: true,
    atBottom: false,
  });

  const releasePin = () => {
    if (!pinnedRef.current) return;
    pinnedRef.current = false;
    rendererRef.current?.setPinnedTop(false);
  };

  useEffect(() => {
    const host = refs.host.current;
    const stage = refs.stage.current;
    const canvas = refs.canvas.current;
    const live = refs.live.current;
    if (!host || !stage || !canvas || !live) return;
    const clock = createMediaClock();
    const renderer = new LyricsCanvasRenderer(
      canvas,
      live,
      clock,
      (atTop, atBottom) => setEdges({ atTop, atBottom }),
    );
    rendererRef.current = renderer;
    const { status, positionMs } = usePlayerStore.getState();
    pinnedRef.current = startsPinnedToTop(status, positionMs);
    renderer.setPinnedTop(pinnedRef.current);
    const pinnedAt = performance.now();

    let size = "";
    const snap = () => {
      const box = snapStage(host, stage);
      const next = `${box.width}x${box.height}@${box.dpr}`;
      if (next === size) return;
      size = next;
      renderer.resize(box.width, box.height, box.dpr);
    };
    const observer = new ResizeObserver(snap);
    observer.observe(host);
    const snapTimer = window.setInterval(snap, SNAP_CHECK_MS);
    // Off-screen (or display: none in a kept page) the loop has nothing to
    // show; stop scheduling frames until the panel is back.
    const stopObserving = observeElementVisible(host, (visible) =>
      renderer.setActive(visible),
    );

    const stopWatchingPlayer = usePlayerStore.subscribe((state, previous) => {
      if (
        state.status === previous.status &&
        state.positionMs === previous.positionMs
      ) {
        return;
      }
      renderer.invalidate();
      if (!pinnedRef.current) return;
      const audio = audioElement();
      const release = shouldReleaseTopPin({
        status: playerEngine.getSnapshot().status,
        audioPaused: !audio || audio.paused,
        audioTimeMs: clock.timeMs(),
        pinnedForMs: performance.now() - pinnedAt,
      });
      if (release) {
        pinnedRef.current = false;
        renderer.setPinnedTop(false);
      }
    });

    return () => {
      stopObserving();
      stopWatchingPlayer();
      window.clearInterval(snapTimer);
      observer.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [refs]);

  useEffect(() => {
    rendererRef.current?.setLyrics(lyrics);
  }, [lyrics]);

  useEffect(() => {
    rendererRef.current?.setFogEnabled(fogEnabled);
  }, [fogEnabled]);

  return { rendererRef, edges, releasePin };
}
