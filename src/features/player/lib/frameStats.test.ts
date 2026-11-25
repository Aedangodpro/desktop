import { describe, expect, it } from "vitest";
import { frameStats } from "./frameStats";

describe("frameStats", () => {
  it("returns null until there are enough frames", () => {
    expect(frameStats([])).toBeNull();
    expect(frameStats([5])).toBeNull();
  });

  it("reports the mean cadence as FPS", () => {
    expect(frameStats([5, 5, 5, 5])).toEqual({
      fps: 200,
      p95Ms: 5,
      samples: 4,
    });
  });

  it("reports the 95th percentile frame time, not the average", () => {
    const deltas = [...Array(19).fill(5), 50];
    const stats = frameStats(deltas);
    expect(stats?.fps).toBeCloseTo(1000 / (145 / 20), 5);
    expect(stats?.p95Ms).toBe(50);
  });

  it("ignores non-positive and non-finite deltas", () => {
    const stats = frameStats([0, -5, Number.NaN, 8, 8]);
    expect(stats).toEqual({ fps: 125, p95Ms: 8, samples: 2 });
  });
});
