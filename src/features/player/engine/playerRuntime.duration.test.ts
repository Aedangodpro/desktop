import { describe, expect, it } from "vitest";
import { playerRuntime } from "./playerRuntime";
import { usePlayerStore } from "../store/playerStore";
import { formatPlaybackTime } from "../ui/TimelineSlider";
import type { Track } from "@/shared/types";

const track: Track = {
  id: "no-duration-header",
  title: "No duration header",
  artists: "Artist",
  durationMs: 364_000,
  coverUrl: "",
  playCount: 0,
};

describe("PlayerRuntime — a media element without a duration header", () => {
  it("keeps the catalog duration when the element reports Infinity", () => {
    const runtime = playerRuntime!;
    const audio = (runtime as unknown as { audio: HTMLAudioElement }).audio;
    const internals = runtime as unknown as { currentTrackId: string | null };
    usePlayerStore.setState({
      currentTrack: track,
      durationMs: track.durationMs,
    });
    internals.currentTrackId = track.id;

    Object.defineProperty(audio, "duration", {
      value: Infinity,
      configurable: true,
    });
    try {
      audio.dispatchEvent(new Event("durationchange"));
      expect(usePlayerStore.getState().durationMs).toBe(track.durationMs);
    } finally {
      Reflect.deleteProperty(audio, "duration");
    }
  });

  it("never stores a non-finite duration", () => {
    usePlayerStore.getState().setDuration(Infinity);
    expect(usePlayerStore.getState().durationMs).toBe(0);
    usePlayerStore.getState().setDuration(Number.NaN);
    expect(usePlayerStore.getState().durationMs).toBe(0);
    usePlayerStore.getState().setDuration(184_000);
    expect(usePlayerStore.getState().durationMs).toBe(184_000);
  });

  it("formats a non-finite duration as 0:00", () => {
    expect(formatPlaybackTime(Infinity)).toBe("0:00");
    expect(formatPlaybackTime(Number.NaN)).toBe("0:00");
    expect(formatPlaybackTime(184_000)).toBe("3:04");
  });
});
