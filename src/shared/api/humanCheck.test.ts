import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HumanCheckCancelledError,
  runHumanCheck,
  setHumanCheckPrompt,
} from "./humanCheck";

describe("human check", () => {
  afterEach(() => setHumanCheckPrompt(null));

  it("asks nothing while the api has the check off", async () => {
    const prompt = vi.fn();
    setHumanCheckPrompt(prompt);
    await expect(runHumanCheck("login", "off")).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("hands the token from the panel to the request", async () => {
    setHumanCheckPrompt(async () => "token");
    await expect(runHumanCheck("register", "required")).resolves.toBe("token");
  });

  it("goes on without a token when an optional check is skipped", async () => {
    setHumanCheckPrompt(async () => null);
    await expect(runHumanCheck("login", "optional")).resolves.toBeUndefined();
  });

  it("stops the sign-in when a required check is closed", async () => {
    setHumanCheckPrompt(async () => null);
    await expect(runHumanCheck("login", "required")).rejects.toBeInstanceOf(
      HumanCheckCancelledError,
    );
  });

  it("resolves the check origin when the api base is a same-origin path", async () => {
    // The web build points VITE_API_URL at "/__liner", which `new URL` cannot
    // parse on its own. It used to throw here, which crashed the check frame
    // and left sign-in waiting forever.
    vi.resetModules();
    vi.stubEnv("VITE_API_URL", "/__liner");
    try {
      const mod = await import("./humanCheck");
      expect(mod.humanCheckPageUrl("login")).toBe(
        "/__liner/v1/auth/verify?action=login",
      );
      expect(() => mod.humanCheckOrigin()).not.toThrow();
      expect(mod.humanCheckOrigin()).toMatch(/^https?:\/\//);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
