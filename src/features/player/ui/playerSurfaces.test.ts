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
    ["FullscreenTrackInfo.tsx", "./FullscreenTrackInfo.tsx"],
    ["Notch.tsx", "../../../shared/ui/Notch.tsx"],
  ])("%s has no live backdrop filter", (_name, path) => {
    expect(read(path)).not.toMatch(/backdrop-blur/);
  });

  /**
   * The lyrics edge blur stays, because it is the effect that reads as the
   * player. Its cost is what a full-height band used to be: ~17 ms per frame
   * at 18%/26% of the viewport. At 56/72 px, masked so the blur is invisible
   * past the band, it is in the noise. Pin the heights so it cannot grow back
   * into the expensive range.
   */
  it("keeps the lyrics edge blur at its cheap height", () => {
    const source = read("./CanvasLyricsView.tsx");
    expect(source).toContain("backdrop-blur-xs");
    expect(source).toContain("h-[56px]");
    expect(source).toContain("h-[72px]");
    expect(source).not.toMatch(/h-\[(1\d|[2-9]\d)%\]/);
  });
});
