import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LyricsSyncBadge } from "./LyricsSyncBadge";
import { useLyricsStore } from "../store/lyricsStore";
import type { LyricsSyncLevel } from "@/shared/contracts/lyrics";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function setActiveProvider(syncLevel: LyricsSyncLevel) {
  useLyricsStore.setState({
    activeProvider: "LRCLIB",
    availableProviders: [
      {
        provider: "LRCLIB",
        syncLevel,
        quality: 80,
        candidate: { syncLevel },
      },
    ] as never,
  });
}

describe("LyricsSyncBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useLyricsStore.setState({
      activeProvider: null,
      availableProviders: [],
    });
  });

  it("marks a line-synced track", () => {
    setActiveProvider("line_level");
    act(() => root.render(<LyricsSyncBadge />));
    expect(container.textContent).toBe("Line-synced");
  });

  it("stays out of the way for word-level timing", () => {
    setActiveProvider("word_level");
    act(() => root.render(<LyricsSyncBadge />));
    expect(container.textContent).toBe("");
  });

  it("stays out of the way for plain lyrics", () => {
    setActiveProvider("plain");
    act(() => root.render(<LyricsSyncBadge />));
    expect(container.textContent).toBe("");
  });
});
