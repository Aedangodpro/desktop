import { useEffect } from "react";
import { IS_WEB_TARGET } from "@/shared/config/runtimeTarget";
import { onYoutubeSignInRequested } from "@/shared/youtube";
import { useYoutubeSignInStore } from "../store/youtubeSignInStore";

export function useYoutubeSignInPrompt(): void {
  const show = useYoutubeSignInStore((state) => state.show);
  useEffect(() => {
    if (IS_WEB_TARGET) return;
    return onYoutubeSignInRequested(() => show("playback"));
  }, [show]);
}
