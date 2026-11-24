import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("./requestSigner", () => ({
  signApiRequest: vi.fn(async () => ({})),
  syncServerTime: vi.fn(),
}));

const STORAGE_KEY = "liner_auth_session";
type SessionModule = typeof import("./auth-session");

let session: SessionModule;

async function loadFreshModule(): Promise<SessionModule> {
  vi.resetModules();
  return import("./auth-session");
}

function tokens(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    user: { id: "u1", username: "leo" },
    ...overrides,
  } as never;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  session = await loadFreshModule();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("session persistence", () => {
  it("persists a session and restores it after a reload", async () => {
    session.setAuthSession(tokens());

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });

    const reloaded = await loadFreshModule();
    expect(reloaded.getAuthSession()).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    expect(reloaded.getAccessToken()).toBe("access-1");
  });

  it("drops a half-written stored session instead of trusting it", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ accessToken: "access-1" }),
    );

    const reloaded = await loadFreshModule();
    expect(reloaded.getAuthSession()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clears the stored session on logout", async () => {
    session.setAuthSession(tokens());
    session.setAuthSession(null);

    expect(session.getAuthSession()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("session expiry", () => {
  it("accepts milliseconds, seconds and ISO timestamps", () => {
    expect(
      session.getSessionExpiryMs(
        tokens({ accessTokenExpiresAt: 1_700_000_000_000 }),
      ),
    ).toBe(1_700_000_000_000);
    expect(
      session.getSessionExpiryMs(
        tokens({ accessTokenExpiresAt: 1_700_000_000 }),
      ),
    ).toBe(1_700_000_000_000);
    expect(
      session.getSessionExpiryMs(
        tokens({
          accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
  });

  it("returns null when no expiry is stored", () => {
    expect(
      session.getSessionExpiryMs(
        tokens({ accessTokenExpiresAt: undefined, expiresAt: undefined }),
      ),
    ).toBeNull();
  });

  it("uses a valid access token without refreshing", async () => {
    session.setAuthSession(tokens());

    await expect(session.getValidAccessToken()).resolves.toBe("access-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a token that expires inside the safety window", async () => {
    session.setAuthSession(
      tokens({ accessTokenExpiresAt: Date.now() + 60_000 }),
    );
    fetchMock.mockResolvedValueOnce(
      json({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        accessTokenExpiresAt: Date.now() + 3_600_000,
      }),
    );

    await expect(session.getValidAccessToken()).resolves.toBe("access-2");

    expect(session.getAuthSession()?.refreshToken).toBe("refresh-2");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).accessToken).toBe(
      "access-2",
    );
  });

  it("keeps the session when a refresh fails transiently", async () => {
    session.setAuthSession(
      tokens({ accessTokenExpiresAt: Date.now() + 60_000 }),
    );
    fetchMock.mockResolvedValueOnce(new Response("error 525", { status: 525 }));

    await expect(session.getValidAccessToken()).resolves.toBe("access-1");
    expect(session.getAuthSession()?.refreshToken).toBe("refresh-1");
  });

  it("signs out when the server rejects the refresh token", async () => {
    session.setAuthSession(tokens({ accessTokenExpiresAt: Date.now() - 1000 }));
    fetchMock.mockResolvedValueOnce(
      json({ code: "INVALID_REFRESH_TOKEN" }, 401),
    );

    await expect(session.getValidAccessToken()).resolves.toBeNull();
    expect(session.getAuthSession()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("logout", () => {
  it("clears the local session even when the logout request fails", async () => {
    session.setAuthSession(tokens());
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));

    await session.clearAuthSession();

    expect(session.getAuthSession()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("gives up on a logout request that never answers", async () => {
    vi.useFakeTimers();
    try {
      session.setAuthSession(tokens());
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );

      const loggingOut = session.clearAuthSession();
      await vi.advanceTimersByTimeAsync(10_000);
      await loggingOut;

      expect(session.getAuthSession()).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the refresh token and the current access token", async () => {
    session.setAuthSession(tokens());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await session.clearAuthSession();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/auth/logout");
    expect(init.headers.Authorization).toBe("Bearer access-1");
    expect(JSON.parse(init.body)).toEqual({ refreshToken: "refresh-1" });
  });
});
