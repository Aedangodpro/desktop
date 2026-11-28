import { describe, expect, it } from "vitest";
import { fitWithin, wallpaperNameFromFile } from "./wallpaperUpload";

describe("fitWithin", () => {
  it("scales wide images to the long edge", () => {
    expect(fitWithin(4000, 2000, 1600)).toEqual({ width: 1600, height: 800 });
  });

  it("scales tall images to the long edge", () => {
    expect(fitWithin(1000, 3000, 1600)).toEqual({ width: 533, height: 1600 });
  });

  it("leaves a small image at its own size", () => {
    expect(fitWithin(320, 180, 1600)).toEqual({ width: 320, height: 180 });
  });
});

describe("wallpaperNameFromFile", () => {
  it("drops only the final extension", () => {
    expect(wallpaperNameFromFile("Sunset over Kyoto.final.png")).toBe(
      "Sunset over Kyoto.final",
    );
  });

  it("returns an empty name for a nameless file", () => {
    expect(wallpaperNameFromFile("   ")).toBe("");
  });
});
