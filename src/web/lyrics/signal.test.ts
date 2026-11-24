import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "./signal";

describe("withTimeout", () => {
  it("aborts when the deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const scope = withTimeout(undefined, 100);
      expect(scope.signal.aborted).toBe(false);

      vi.advanceTimersByTime(100);

      expect(scope.signal.aborted).toBe(true);
      expect(scope.timedOut()).toBe(true);
      scope.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the caller's abort", () => {
    const caller = new AbortController();
    const scope = withTimeout(caller.signal, 10_000);

    caller.abort();

    expect(scope.signal.aborted).toBe(true);
    expect(scope.timedOut()).toBe(false);
    scope.dispose();
  });

  it("aborts immediately for an already aborted caller", () => {
    const caller = new AbortController();
    caller.abort();
    const scope = withTimeout(caller.signal, 10_000);
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it("stops the deadline after dispose", () => {
    vi.useFakeTimers();
    try {
      const scope = withTimeout(undefined, 100);
      scope.dispose();
      vi.advanceTimersByTime(500);
      expect(scope.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
