import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthTokens } from "@/shared/api/auth-session";

/**
 * "Refreshing the page signs me out" is the web equivalent of losing the
 * session file on desktop: the tokens must round-trip through storage and be
 * re-read by a freshly started module, and a stale/garbage value must never be
 * mistaken for a real session.
 */

const STORAGE_KEY = "liner_auth_session";

const store = new Map<string, string>();

const localStorageMock = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => store.clear(),
};

const session: AuthTokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  user: { id: "user-1", username: "listener" },
};

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
  vi.resetModules();
});

afterEach(() => {
  store.clear();
});

/** A fresh module instance stands in for a page reload. */
async function afterReload() {
  vi.resetModules();
  return import("@/shared/api/auth-session");
}

describe("web session persistence", () => {
  it("restores the account after a reload", async () => {
    const first = await afterReload();
    first.setAuthSession(session);
    expect(store.get(STORAGE_KEY)).toBeTruthy();

    const reloaded = await afterReload();
    const restored = reloaded.getAuthSession();

    expect(restored?.accessToken).toBe("access-token");
    expect(restored?.refreshToken).toBe("refresh-token");
    expect(restored?.user.username).toBe("listener");
  });

  it("clears the session only when it is actually removed", async () => {
    const first = await afterReload();
    first.setAuthSession(session);
    first.setAuthSession(null);

    const reloaded = await afterReload();
    expect(reloaded.getAuthSession()).toBeNull();
    expect(store.get(STORAGE_KEY)).toBeUndefined();
  });

  it("rejects a stored value that has no usable tokens", async () => {
    store.set(STORAGE_KEY, JSON.stringify({ user: { id: "user-1" } }));

    const reloaded = await afterReload();
    expect(reloaded.getAuthSession()).toBeNull();
    // and it stops the bad value being re-read on every call
    expect(store.get(STORAGE_KEY)).toBeUndefined();
  });

  it("survives unparseable storage instead of throwing", async () => {
    store.set(STORAGE_KEY, "{not json");

    const reloaded = await afterReload();
    expect(reloaded.getAuthSession()).toBeNull();
  });
});
