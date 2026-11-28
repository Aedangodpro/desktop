import { describe, expect, it } from "vitest";
import { neutralWallpaperPalette, paletteFromPixels } from "./wallpaperPalette";

function solidPixels(
  colour: [number, number, number],
  count: number,
): number[] {
  const pixels: number[] = [];
  for (let i = 0; i < count; i++) {
    pixels.push(colour[0], colour[1], colour[2], 255);
  }
  return pixels;
}

function parseHsl(value: string): [number, number, number] {
  const match = value.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!match) throw new Error(`Not an hsl() colour: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe("paletteFromPixels", () => {
  it("takes the accent hue from the dominant colour", () => {
    const pixels = [
      ...solidPixels([128, 62, 232], 200),
      ...solidPixels([24, 36, 96], 60),
    ];
    const palette = paletteFromPixels(pixels, true);
    const [hue, saturation] = parseHsl(palette.accent);

    expect(hue).toBeGreaterThan(250);
    expect(hue).toBeLessThan(290);
    expect(saturation).toBeGreaterThan(50);
    expect(palette.swatches).toHaveLength(3);
  });

  it("darkens the accent for the light theme and lifts it for the dark one", () => {
    const pixels = solidPixels([210, 96, 64], 120);
    const [, , darkLightness] = parseHsl(
      paletteFromPixels(pixels, true).accent,
    );
    const [, , lightLightness] = parseHsl(
      paletteFromPixels(pixels, false).accent,
    );

    expect(darkLightness).toBeGreaterThan(lightLightness);
    expect(lightLightness).toBeLessThan(55);
  });

  it("keeps a grey wallpaper quiet instead of inventing a colour", () => {
    const palette = paletteFromPixels(solidPixels([120, 120, 120], 120), true);
    const [, saturation] = parseHsl(palette.accent);

    expect(saturation).toBeLessThanOrEqual(30);
    expect(palette.accent).not.toContain("NaN");
  });

  it("falls back to the neutral palette when every pixel is transparent", () => {
    expect(paletteFromPixels(new Uint8ClampedArray(64), true)).toEqual(
      neutralWallpaperPalette(true),
    );
  });

  it("is deterministic for the same pixels", () => {
    const pixels = [
      ...solidPixels([40, 160, 150], 40),
      ...solidPixels([220, 180, 70], 30),
    ];
    expect(paletteFromPixels(pixels, false)).toEqual(
      paletteFromPixels(pixels, false),
    );
  });
});
