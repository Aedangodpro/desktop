import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChunkLoadRecovery } from "./chunkLoadRecovery";

describe("installChunkLoadRecovery", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("reloads the page once a chunk from the previous deploy is missing", () => {
    const reload = vi.fn();
    const uninstall = installChunkLoadRecovery(reload);
    try {
      window.dispatchEvent(new Event("vite:preloadError"));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it("stays put inside the cooldown, so a broken deployment cannot loop", () => {
    const reload = vi.fn();
    const uninstall = installChunkLoadRecovery(reload);
    try {
      window.dispatchEvent(new Event("vite:preloadError"));
      window.dispatchEvent(new Event("vite:preloadError"));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it("stops listening once uninstalled", () => {
    const reload = vi.fn();
    installChunkLoadRecovery(reload)();
    window.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).not.toHaveBeenCalled();
  });
});
