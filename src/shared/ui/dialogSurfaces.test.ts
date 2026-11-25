import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This folder runs under jsdom, where import.meta.url is not a file: URL.
// Block comments are stripped because the source names the property it removed.
const source = readFileSync(
  resolve(process.cwd(), "src/shared/ui/Dialog.tsx"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * A dialog sits above a full-screen scrim, so any backdrop-filter here is
 * re-run for the whole page behind it whenever the dialog's own content
 * changes — every keystroke in a form. Measured at 1440x900 in the production
 * web build: 63 ms of frame time per key with both the scrim and panel blurs,
 * and 12 ms with neither. The panel background (`--surface-glass`) is 90%
 * opaque, so the blur was not visible enough to be worth that.
 */
describe("dialog surfaces", () => {
  it("has no live backdrop filter", () => {
    expect(source).not.toMatch(/backdrop-blur/);
    expect(source).not.toMatch(/backdrop-filter/);
    expect(source).not.toContain("PANEL_GLASS_CLASS");
  });

  it("keeps the scrim a static translucency", () => {
    expect(source).toContain("bg-black/15");
    expect(source).toContain("bg-surface-glass");
  });
});
