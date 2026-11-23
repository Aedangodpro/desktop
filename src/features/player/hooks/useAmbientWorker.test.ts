import { describe, expect, it } from "vitest";
import {
  AMBIENT_BLUR_SOFTEN_SCALE,
  ambientCssBlur,
  ambientRenderScale,
} from "./useAmbientWorker";

describe("ambient surface policy", () => {
  it("keeps the requested scale when the effect wants no softening", () => {
    expect(ambientRenderScale(0.5, 0)).toBe(0.5);
    expect(ambientRenderScale(0.5, undefined)).toBe(0.5);
  });

  it("renders smaller instead of paying a CSS blur pass for a small blur", () => {
    expect(ambientRenderScale(0.5, 1.5)).toBe(0.5 * AMBIENT_BLUR_SOFTEN_SCALE);
    expect(ambientCssBlur(1.5)).toBeUndefined();
  });

  it("keeps a real blur on the compositor", () => {
    expect(ambientCssBlur(8)).toBe("blur(8px)");
    expect(ambientRenderScale(0.5, 8)).toBe(0.5);
  });

  it("clamps scales the effect asks for", () => {
    expect(ambientRenderScale(4, 0)).toBe(1);
    expect(ambientRenderScale(0.001, 0)).toBe(0.05);
    expect(ambientRenderScale(undefined, 0)).toBe(0.5);
  });
});
