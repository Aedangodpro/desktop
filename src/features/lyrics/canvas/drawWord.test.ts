import { describe, expect, it } from "vitest";
import { drawToken, white, type TokenPaint } from "./drawWord";
import type { PlacedToken } from "./types";

function makeContext() {
  const calls: string[] = [];
  let gradients = 0;
  const ctx = {
    fillStyle: "",
    shadowColor: "",
    shadowBlur: 0,
    save() {},
    restore() {},
    createLinearGradient() {
      gradients += 1;
      return { addColorStop() {} };
    },
    fillText(text: string) {
      calls.push(text);
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    calls,
    gradients: () => gradients,
    fillStyles: () => ctx.fillStyle,
  };
}

const placed: PlacedToken = {
  token: {
    text: "word",
    startMs: 0,
    durationMs: 300,
    background: false,
    space: false,
  },
  x: 0,
  baseline: 24,
  width: 64,
};

function paint(ctx: CanvasRenderingContext2D): TokenPaint {
  return { ctx, top: 0, rtl: false, base: 0.3, remPx: 16, dpr: 2 };
}

describe("drawToken", () => {
  it("paints the muted base only once before a token is sung", () => {
    const { ctx, calls, gradients } = makeContext();
    drawToken(paint(ctx), placed, null);
    expect(calls).toEqual(["word"]);
    expect(gradients()).toBe(0);
  });

  it("paints base and highlight while the sweep is mid-token", () => {
    const { ctx, calls, gradients } = makeContext();
    drawToken(paint(ctx), placed, {
      opacity: 1,
      solid: 0.4,
      clear: 0.5,
      glowRem: 0,
    });
    expect(calls).toEqual(["word", "word"]);
    expect(gradients()).toBe(1);
  });

  it("skips the covered base pass once the token is fully lit", () => {
    const { ctx, calls, gradients } = makeContext();
    drawToken(paint(ctx), placed, {
      opacity: 1,
      solid: 1.2,
      clear: 1.3,
      glowRem: 0,
    });
    expect(calls).toEqual(["word"]);
    expect(gradients()).toBe(0);
  });

  it("keeps the glow pass for a long word even when fully lit", () => {
    const { ctx, calls } = makeContext();
    drawToken(paint(ctx), placed, {
      opacity: 1,
      solid: 1.4,
      clear: 1.5,
      glowRem: 0.6,
    });
    expect(calls).toEqual(["word"]);
    expect(ctx.shadowBlur).toBeGreaterThan(0);
  });

  it("interns the colour strings instead of rebuilding them per token", () => {
    expect(white(0.3)).toBe(white(0.3));
    expect(white(0.3)).toBe("rgba(255, 255, 255, 0.302)");
    expect(white(-1)).toBe("rgba(255, 255, 255, 0.000)");
    expect(white(2)).toBe("rgba(255, 255, 255, 1.000)");
  });
});
