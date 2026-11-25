import { describe, expect, it } from "vitest";
import { isFrameDue } from "./kawarpEngine";

/**
 * Replays the render loop against a display of a given refresh rate: a frame is
 * drawn only when `isFrameDue` agrees, and the last drawn frame becomes the
 * reference for the next one.
 */
function framesPerSecond(refreshHz: number, maxFps: number, durationMs = 1000) {
  const interval = 1000 / refreshHz;
  let last = 0;
  let frames = 0;
  for (
    let timestamp = interval;
    timestamp < durationMs;
    timestamp += interval
  ) {
    if (!isFrameDue(last, timestamp, maxFps)) continue;
    last = timestamp;
    frames += 1;
  }
  return frames / (durationMs / 1000);
}

describe("kawarp frame pacing", () => {
  it("follows a 60 Hz display at 60 fps", () => {
    expect(framesPerSecond(60, 60)).toBeCloseTo(60, 0);
  });

  it("keeps 60 fps on a 120 Hz display instead of doubling the work", () => {
    const fps = framesPerSecond(120, 60);
    expect(fps).toBeGreaterThanOrEqual(58);
    expect(fps).toBeLessThanOrEqual(61);
  });

  it("reaches the 60 fps target on a 144 Hz display instead of stalling at 48", () => {
    // A whole-interval wait lands on 3 refresh slots here: 20.8 ms, 48 fps.
    const fps = framesPerSecond(144, 60);
    expect(fps).toBeGreaterThan(48);
    expect(fps).toBeLessThanOrEqual(72.5);
  });

  it("follows a 144 Hz display in full visuals instead of holding 60", () => {
    const fps = framesPerSecond(144, 1000);
    expect(fps).toBeGreaterThanOrEqual(143);
    expect(fps).toBeLessThanOrEqual(144);
  });

  it("follows a 200 Hz display in full visuals", () => {
    const fps = framesPerSecond(200, 1000);
    expect(fps).toBeGreaterThanOrEqual(199);
    expect(fps).toBeLessThanOrEqual(200);
  });

  it("still throttles the cheaper visual mode to roughly 30 fps", () => {
    const fps = framesPerSecond(60, 30);
    expect(fps).toBeGreaterThanOrEqual(28);
    expect(fps).toBeLessThanOrEqual(32);
  });

  it("draws balanced at half of a 144 Hz display", () => {
    const fps = framesPerSecond(144, 72);
    expect(fps).toBeGreaterThanOrEqual(70);
    expect(fps).toBeLessThanOrEqual(73);
  });

  it("draws balanced at half of a 200 Hz display", () => {
    const fps = framesPerSecond(200, 100);
    expect(fps).toBeGreaterThanOrEqual(98);
    expect(fps).toBeLessThanOrEqual(101);
  });

  it("clamps absurd frame rates", () => {
    expect(isFrameDue(0, 1, 0)).toBe(false);
    expect(isFrameDue(0, 1, Number.NaN)).toBe(false);
    expect(isFrameDue(0, 10_000, 10_000)).toBe(true);
  });
});
