import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ resolvePlaybackStream: vi.fn() }));

vi.mock("./streamResolver", () => ({
  resolvePlaybackStream: mocks.resolvePlaybackStream,
}));

// the browser build is the one that waits for playback before caching
vi.mock("@/shared/config/runtimeTarget", () => ({
  IS_WEB_TARGET: true,
  IS_DESKTOP_TARGET: false,
}));

import { playerRuntime } from "./playerRuntime";
import { usePlayerStore } from "../store/playerStore";
import { linerDb } from "@/shared/storage";
import type { Track } from "@/shared/types";

const stream = {
  url: "https://rr1.googlevideo.com/videoplayback?itag=251",
  mimeType: "audio/webm",
  codec: "opus",
  bitrate: 128000,
  expiresAtMs: null,
};

const AUDIO_BYTES = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0,
]);

function makeTrack(id: string): Track {
  return {
    id,
    title: id,
    artists: "Artist",
    durationMs: 200_000,
    coverUrl: "",
    playCount: 0,
  };
}

describe("PlayerRuntime — the web cache follows what actually played", () => {
  const runtime = playerRuntime!;
  const audio = (runtime as unknown as { audio: HTMLAudioElement }).audio;
  let position = 0;

  beforeEach(() => {
    position = 0;
    Object.defineProperty(audio, "currentTime", {
      get: () => position,
      set: (value: number) => {
        position = value;
      },
      configurable: true,
    });
    Object.defineProperty(audio, "ended", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(audio, "readyState", {
      value: 4,
      configurable: true,
    });
    Object.defineProperty(audio, "paused", {
      value: false,
      configurable: true,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    mocks.resolvePlaybackStream.mockResolvedValue(stream);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(AUDIO_BYTES, {
        status: 206,
        headers: { "content-type": "audio/webm" },
      }),
    );
    usePlayerStore.setState({
      status: "idle",
      currentTrack: null,
      queue: [],
      currentIndex: 0,
      positionMs: 0,
      durationMs: 0,
      volume: 1,
      error: null,
    });
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    runtime.stop();
    Reflect.deleteProperty(audio, "currentTime");
    Reflect.deleteProperty(audio, "ended");
    Reflect.deleteProperty(audio, "readyState");
    Reflect.deleteProperty(audio, "paused");
  });

  /** Lets the media clock advance one second per step, as the element reports it. */
  async function playFor(seconds: number) {
    for (let i = 0; i < seconds; i += 1) {
      position += 1;
      await vi.advanceTimersByTimeAsync(1000);
    }
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it("caches a track resumed partway through", async () => {
    position = 45;
    const resumed = makeTrack("resumed-partway");
    await runtime.loadAndPlay(resumed, 45_000);

    await playFor(2);
    expect(await linerDb.getAudio("resumed-partway")).toBeNull();

    await playFor(1);
    const stored = await linerDb.getAudio("resumed-partway");
    expect(stored?.byteSize).toBe(AUDIO_BYTES.byteLength);
  });

  it("does not cache a track skipped past before it played", async () => {
    const skipped = makeTrack("skipped-early");
    await runtime.loadAndPlay(skipped);
    await playFor(2);

    const listened = makeTrack("listened-through");
    await runtime.loadAndPlay(listened);
    await playFor(3);

    expect(await linerDb.getAudio("skipped-early")).toBeNull();
    const stored = await linerDb.getAudio("listened-through");
    expect(stored?.byteSize).toBe(AUDIO_BYTES.byteLength);
  });
});
