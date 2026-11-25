import { describe, expect, it } from "vitest";
import {
  FALLBACK_REFRESH_HZ,
  refreshRateFromDeltas,
  snapRefreshRate,
} from "./useDisplayRefreshRate";

/** `n` frame deltas that match a display at `hz`. */
function deltas(hz: number, n = 120): number[] {
  return Array.from({ length: n }, () => 1000 / hz);
}

describe("display refresh rate", () => {
  it("snaps measured rates to the panel they belong to", () => {
    expect(snapRefreshRate(59.94)).toBe(60);
    expect(snapRefreshRate(119.7)).toBe(120);
    expect(snapRefreshRate(143.6)).toBe(144);
    expect(snapRefreshRate(199.4)).toBe(200);
    expect(snapRefreshRate(165)).toBe(165);
  });

  it("keeps an unusual panel at its measured rate", () => {
    expect(snapRefreshRate(85)).toBe(85);
  });

  it("falls back to 60 Hz for a value it cannot use", () => {
    expect(snapRefreshRate(Number.NaN)).toBe(FALLBACK_REFRESH_HZ);
    expect(snapRefreshRate(0)).toBe(FALLBACK_REFRESH_HZ);
    expect(snapRefreshRate(-120)).toBe(FALLBACK_REFRESH_HZ);
  });

  it("reads 60, 144 and 200 Hz from frame deltas", () => {
    expect(refreshRateFromDeltas(deltas(60))).toBe(60);
    expect(refreshRateFromDeltas(deltas(144))).toBe(144);
    expect(refreshRateFromDeltas(deltas(200))).toBe(200);
  });

  it("ignores hitches instead of halving the rate", () => {
    const samples = deltas(200).map((d, i) => (i % 5 === 0 ? 40 : d));
    expect(refreshRateFromDeltas(samples)).toBe(200);
  });

  it("needs a usable sample before it trusts a rate", () => {
    expect(refreshRateFromDeltas(deltas(60, 4))).toBe(FALLBACK_REFRESH_HZ);
    expect(refreshRateFromDeltas([])).toBe(FALLBACK_REFRESH_HZ);
  });
});
