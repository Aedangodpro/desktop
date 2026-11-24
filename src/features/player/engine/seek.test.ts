import { describe, expect, it, vi } from "vitest";
import { applyMediaSeek, clampSeekSeconds } from "./seek";

function media(
  duration: number,
  options: { fastSeek?: (time: number) => void } = {},
) {
  return {
    currentTime: 0,
    duration,
    ...options,
  };
}

describe("clampSeekSeconds", () => {
  it("clamps to the media bounds", () => {
    expect(clampSeekSeconds(-5_000, 200)).toBe(0);
    expect(clampSeekSeconds(120_000, 200)).toBe(120);
    expect(clampSeekSeconds(200_000, 120)).toBe(120);
  });

  it("does not clamp when the duration is unknown", () => {
    expect(clampSeekSeconds(90_000, Number.NaN)).toBe(90);
    expect(clampSeekSeconds(90_000, 0)).toBe(90);
  });

  it("treats a non-finite position as zero", () => {
    expect(clampSeekSeconds(Number.NaN, 100)).toBe(0);
  });
});

describe("applyMediaSeek", () => {
  it("uses fastSeek for scrubbing when the element implements it", () => {
    const fastSeek = vi.fn();
    const element = media(180, { fastSeek });

    expect(applyMediaSeek(element, 30_000, 0, { fast: true })).toBe(30);
    expect(fastSeek).toHaveBeenCalledWith(30);
    expect(element.currentTime).toBe(0);
  });

  it("keeps an exact seek exact even when fastSeek is available", () => {
    const fastSeek = vi.fn();
    const element = media(180, { fastSeek });

    expect(applyMediaSeek(element, 30_000)).toBe(30);
    expect(fastSeek).not.toHaveBeenCalled();
    expect(element.currentTime).toBe(30);
  });

  it("falls back to currentTime when a scrub's fastSeek is missing", () => {
    const element = media(180);
    applyMediaSeek(element, 30_000, 0, { fast: true });
    expect(element.currentTime).toBe(30);
  });

  it("falls back to currentTime when a scrub's fastSeek throws", () => {
    const element = media(180, {
      fastSeek: () => {
        throw new DOMException("not seekable", "InvalidStateError");
      },
    });
    applyMediaSeek(element, 30_000, 0, { fast: true });
    expect(element.currentTime).toBe(30);
  });

  it("clamps against the element duration", () => {
    const element = media(120);
    expect(applyMediaSeek(element, 500_000)).toBe(120);
    expect(element.currentTime).toBe(120);
  });

  it("uses the fallback duration before metadata arrives", () => {
    const element = media(Number.NaN);
    expect(applyMediaSeek(element, 90_000, 60_000)).toBe(60);
    expect(element.currentTime).toBe(60);
  });
});
