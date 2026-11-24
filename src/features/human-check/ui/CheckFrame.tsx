import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib";
import {
  humanCheckOrigin,
  humanCheckPageUrl,
  type HumanCheckAction,
} from "@/shared/api";
import { useHumanCheckStore } from "../store/humanCheckStore";

interface CheckMessage {
  source?: string;
  action?: string;
  type?: "token" | "error" | "expired";
  token?: string;
}

const LOAD_TIMEOUT_MS = 12_000;

export interface CheckFrameProps {
  action: HumanCheckAction;
  attempt: number;
}

export default function CheckFrame({ action, attempt }: CheckFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const phase = useHumanCheckStore((state) => state.phase);
  const setPhase = useHumanCheckStore((state) => state.setPhase);
  const solve = useHumanCheckStore((state) => state.solve);
  const ready = phase !== "loading";

  useEffect(() => {
    const origin = humanCheckOrigin();
    const onMessage = (event: MessageEvent<CheckMessage>) => {
      if (event.origin !== origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (data?.source !== "liner-turnstile" || data.action !== action) return;
      if (data.type === "token" && data.token) solve(data.token);
      else if (data.type === "expired") setPhase("expired");
      else if (data.type === "error") setPhase("error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [action, setPhase, solve]);

  // A frame the page is not allowed to embed fires no useful load and never
  // posts a token, which used to leave sign-in waiting forever behind a white
  // box. Report the failure so the panel offers a retry instead.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (useHumanCheckStore.getState().phase === "loading") setPhase("error");
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [attempt, setPhase]);

  const markLoaded = () => {
    if (useHumanCheckStore.getState().phase === "loading") setPhase("ready");
  };

  return (
    <div className="relative mx-auto h-[88px] w-[320px] shrink-0">
      <div
        className={cn(
          "absolute inset-x-[10px] top-[11px] h-[65px] animate-pulse rounded-[10px] bg-fill-hover transition-opacity duration-300",
          ready && "opacity-0",
        )}
      />
      <iframe
        key={attempt}
        ref={frameRef}
        src={humanCheckPageUrl(action)}
        title="Cloudflare Turnstile"
        scrolling="no"
        onLoad={markLoaded}
        className={cn(
          "absolute inset-0 size-full border-0 bg-transparent opacity-0 transition-opacity duration-300 ease-out [color-scheme:dark]",
          ready && phase !== "error" && "opacity-100",
        )}
      />
    </div>
  );
}
