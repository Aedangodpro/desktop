import { describe, expect, it } from "vitest";
import { isStrained } from "./useFrameStrain";

/** `n` frame deltas that match a display at `hz`. */
function frames(hz: number, n = 200): number[] {
  return Array.from({ length: n }, () => 1000 / hz);
}

describe("adaptive visual step-down", () => {
  it("does not call a healthy 200 Hz display strained", () => {
    expect(isStrained(frames(200))).toBe(false);
  });

  it("tolerates doubled frames on a 200 Hz display", () => {
    // ~10 ms is two refreshes at 200 Hz: slower than the cadence, not a
    // struggling GPU, and it used to trigger a downgrade.
    const deltas = frames(200).map((d, i) => (i % 3 === 0 ? d * 2 : d));
    expect(isStrained(deltas)).toBe(false);
  });

  it("flags real hitches on a 200 Hz display", () => {
    const deltas = frames(200).map((d, i) => (i % 3 === 0 ? 40 : d));
    expect(isStrained(deltas)).toBe(true);
  });

  it("still catches a steady but slow cadence", () => {
    expect(isStrained(frames(20))).toBe(true);
  });

  it("leaves a healthy 60 Hz display alone", () => {
    expect(isStrained(frames(60))).toBe(false);
  });
});
