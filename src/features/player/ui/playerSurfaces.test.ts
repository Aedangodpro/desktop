import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/**
 * These surfaces float above the player's WebGL background. A `backdrop-filter`
 * on any of them is re-run by the compositor on every frame that background
 * moves, which is most frames of a song. It is the one cost in the player that
 * grows with the monitor while the work behind it stays the same, and it is
 * invisible at the radii these panels use — hence static translucency instead.
 */
describe("player chrome above the animated background", () => {
  it.each([
    ["CanvasLyricsView.tsx", "./CanvasLyricsView.tsx"],
    ["FullscreenTrackInfo.tsx", "./FullscreenTrackInfo.tsx"],
    ["Notch.tsx", "../../../shared/ui/Notch.tsx"],
  ])("%s has no live backdrop filter", (_name, path) => {
    expect(read(path)).not.toMatch(/backdrop-blur/);
  });
});
