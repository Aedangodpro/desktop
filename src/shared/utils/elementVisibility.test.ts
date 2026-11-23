import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ELEMENT_HIDE_DELAY_MS,
  observeElementVisible,
} from "./elementVisibility";

type Callback = (entries: { isIntersecting: boolean }[]) => void;

describe("observeElementVisible", () => {
  let callbacks: Callback[];
  let disconnected = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = [];
    disconnected = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: Callback) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {
          disconnected++;
        }
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const emit = (isIntersecting: boolean) => {
    for (const callback of callbacks) callback([{ isIntersecting }]);
  };

  it("reports visible immediately and hidden only after the dwell delay", () => {
    const seen: boolean[] = [];
    observeElementVisible(document.createElement("div"), (v) => seen.push(v));
    emit(false);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(ELEMENT_HIDE_DELAY_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([false]);
  });

  it("does not report hidden when the element comes back during a transition", () => {
    const seen: boolean[] = [];
    observeElementVisible(document.createElement("div"), (v) => seen.push(v));
    emit(false);
    vi.advanceTimersByTime(ELEMENT_HIDE_DELAY_MS / 2);
    emit(true);
    vi.advanceTimersByTime(ELEMENT_HIDE_DELAY_MS * 2);
    expect(seen).toEqual([]);
  });

  it("reports visible again once the element is back, and stops on dispose", () => {
    const seen: boolean[] = [];
    const dispose = observeElementVisible(
      document.createElement("div"),
      (v) => seen.push(v),
    );
    emit(false);
    vi.advanceTimersByTime(ELEMENT_HIDE_DELAY_MS);
    emit(true);
    expect(seen).toEqual([false, true]);
    dispose();
    expect(disconnected).toBe(1);
  });

  it("assumes visible when IntersectionObserver is missing", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", undefined);
    const seen: boolean[] = [];
    observeElementVisible(document.createElement("div"), (v) => seen.push(v));
    expect(seen).toEqual([true]);
  });
});
