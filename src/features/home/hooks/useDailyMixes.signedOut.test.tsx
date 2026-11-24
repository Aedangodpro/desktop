import React from "react";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

const api = vi.hoisted(() => ({
  getDailyMixes: vi.fn(),
  getHistory: vi.fn(),
}));

vi.mock("@/shared/api", () => ({
  api,
  getAuthSession: () => null,
  mediaUrl: (url: string) => url,
  toClientTrack: (track: any) => track,
}));

import { useDailyMixes } from "./useDailyMixes";
import { useRecentlyPlayed } from "./useRecentlyPlayed";

function Probe() {
  const mixes = useDailyMixes();
  const recent = useRecentlyPlayed(10);
  return (
    <div>
      {mixes.data.length}:{String(mixes.isLoading)}:{recent.data.length}:
      {String(recent.isLoading)}
    </div>
  );
}

describe("per-account home resources without a session", () => {
  it("request nothing and are not stuck loading", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<Probe />);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(api.getDailyMixes).not.toHaveBeenCalled();
      expect(api.getHistory).not.toHaveBeenCalled();
      expect(container.textContent).toBe("0:false:0:false");
    } finally {
      act(() => root.unmount());
      document.body.removeChild(container);
    }
  });
});
