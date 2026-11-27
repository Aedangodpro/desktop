import { describe, expect, it } from "vitest";
import { PlaybackCacheClock } from "./playbackCacheClock";

function elementAt(currentTime: number) {
  return { currentTime };
}

describe("PlaybackCacheClock", () => {
  it("counts playback from the position it started at", () => {
    let now = 0;
    const audio = elementAt(42);
    const clock = new PlaybackCacheClock(audio, () => now);
    for (let i = 0; i < 4; i += 1) {
      now += 1000;
      audio.currentTime += 1;
      clock.observe();
    }
    expect(clock.observe()).toBe(4000);
  });

  it("does not let a seek forward pass the threshold", () => {
    let now = 0;
    const audio = elementAt(0);
    const clock = new PlaybackCacheClock(audio, () => now);
    now += 250;
    audio.currentTime = 60;
    expect(clock.observe()).toBe(250);
    now += 250;
    audio.currentTime = 60.25;
    expect(clock.observe()).toBe(500);
  });

  it("counts nothing while playback is paused", () => {
    let now = 0;
    const audio = elementAt(10);
    const clock = new PlaybackCacheClock(audio, () => now);
    now += 60_000;
    expect(clock.observe()).toBe(0);
  });

  it("counts playback between coarse timeupdates in a background tab", () => {
    let now = 0;
    const audio = elementAt(10);
    const clock = new PlaybackCacheClock(audio, () => now);
    now += 4000;
    audio.currentTime += 4;
    expect(clock.observe()).toBe(4000);
  });

  it("counts a seek backwards as no playback", () => {
    let now = 0;
    const audio = elementAt(90);
    const clock = new PlaybackCacheClock(audio, () => now);
    now += 300;
    audio.currentTime = 20;
    expect(clock.observe()).toBe(0);
  });
});
