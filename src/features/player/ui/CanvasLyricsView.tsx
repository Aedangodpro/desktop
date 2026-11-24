import { useEffect, useMemo, useRef } from "react";
import type { Lyric } from "@braccato/parsers";
import { useLyricsEdgeFade } from "../store/visualModeStore";
import { useLyricsCanvas } from "../hooks/useLyricsCanvas";
import { playerEngine } from "../engine/playerEngine";

const FREE_SCROLL_MS = 6000;
const LINE_DELTA_PX = 40;

export interface CanvasLyricsViewProps {
  lyrics: Lyric[];
}

export function CanvasLyricsView({ lyrics }: CanvasLyricsViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveRef = useRef<HTMLCanvasElement | null>(null);
  const refs = useMemo(
    () => ({
      host: hostRef,
      stage: stageRef,
      canvas: canvasRef,
      live: liveRef,
    }),
    [],
  );
  const freeTimerRef = useRef<number | null>(null);
  const edgeFade = useLyricsEdgeFade();
  const { rendererRef, releasePin } = useLyricsCanvas(refs, lyrics, edgeFade);

  const clearFreeTimer = () => {
    if (freeTimerRef.current === null) return;
    window.clearTimeout(freeTimerRef.current);
    freeTimerRef.current = null;
  };

  const followAgain = () => {
    clearFreeTimer();
    rendererRef.current?.follow();
  };

  useEffect(() => clearFreeTimer, []);

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const scale = event.deltaMode === 1 ? LINE_DELTA_PX : 1;
    releasePin();
    rendererRef.current?.wheel(event.deltaY * scale);
    clearFreeTimer();
    freeTimerRef.current = window.setTimeout(followAgain, FREE_SCROLL_MS);
  };

  const lineStartAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return rendererRef.current?.lineStartAt(event.clientY - rect.top) ?? null;
  };

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const startMs = lineStartAt(event);
    if (startMs === null) return;
    releasePin();
    playerEngine.seek(startMs, true);
    followAgain();
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const cursor = lineStartAt(event) === null ? "default" : "pointer";
    if (event.currentTarget.style.cursor !== cursor) {
      event.currentTarget.style.cursor = cursor;
    }
  };

  return (
    <div
      ref={hostRef}
      className="relative flex flex-col flex-1 w-full h-full min-h-0"
    >
      <div ref={stageRef} className="absolute top-0 left-0">
        <canvas
          ref={canvasRef}
          aria-hidden
          onWheel={handleWheel}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          className="absolute inset-0 block h-full w-full"
        />
        <canvas
          ref={liveRef}
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 w-full"
        />
      </div>
      {/* No backdrop-filter here. A blur band above a canvas that repaints at
          the display rate is re-blurred on every one of those frames, and that
          compositor pass is the one cost in this view that scales with the
          monitor rather than with the lyrics. The canvas already fades its own
          content at the edges (`EdgeFog`), which is what the band was for. */}
    </div>
  );
}
