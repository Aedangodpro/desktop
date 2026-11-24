import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LyricsCandidate } from "@/shared/contracts/lyrics";

const mocks = vi.hoisted(() => ({
  searchLyrics: vi.fn(),
  getAuthSession: vi.fn(),
}));

vi.mock("@/shared/api", () => ({
  api: { searchLyrics: mocks.searchLyrics },
}));

vi.mock("@/shared/api/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
}));

import { fetchLinerLyrics, linerLyricsProvider } from "./linerLyrics";
import { webLyricsProviders } from "./resolveLyrics";

function candidate(overrides: Partial<LyricsCandidate> = {}): LyricsCandidate {
  return {
    provider: "Liner",
    contentKind: "syllable_synced",
    syncLevel: "syllable_level",
    lyrics: { format: "richsync", content: "line" },
    quality: {
      total: 96,
      match: 99,
      content: 95,
      sync: 97,
      source: 90,
      reasons: [],
    },
    ...overrides,
  };
}

const hint = { title: "Yellow", artist: "Coldplay", durationMs: 266_000 };

beforeEach(() => {
  mocks.searchLyrics.mockReset();
  mocks.getAuthSession.mockReset();
});

describe("fetchLinerLyrics", () => {
  it("marks a valid Liner answer as top priority", async () => {
    mocks.getAuthSession.mockReturnValue({ accessToken: "token" });
    mocks.searchLyrics.mockResolvedValue({
      cached: false,
      candidate: candidate({ provider: "Liner Atlas" }),
    });

    const result = await fetchLinerLyrics(hint);

    expect(mocks.searchLyrics).toHaveBeenCalledWith(hint, undefined);
    expect(result).toMatchObject({
      provider: "Liner Atlas",
      topPriority: true,
      syncLevel: "syllable_level",
    });
  });

  it("falls back to the Liner name when the server omits it", async () => {
    mocks.getAuthSession.mockReturnValue({ accessToken: "token" });
    mocks.searchLyrics.mockResolvedValue({
      cached: false,
      candidate: candidate({ provider: "" }),
    });

    expect((await fetchLinerLyrics(hint))?.provider).toBe("Liner");
  });

  it("does not call the API when signed out", async () => {
    mocks.getAuthSession.mockReturnValue(null);

    expect(await fetchLinerLyrics(hint)).toBeNull();
    expect(mocks.searchLyrics).not.toHaveBeenCalled();
  });

  it("ignores an empty candidate", async () => {
    mocks.getAuthSession.mockReturnValue({ accessToken: "token" });
    mocks.searchLyrics.mockResolvedValue({
      cached: false,
      candidate: candidate({ lyrics: { format: "lrc", content: "  " } }),
    });

    expect(await fetchLinerLyrics(hint)).toBeNull();
  });
});

describe("webLyricsProviders", () => {
  it("puts Liner first only when signed in, keeping the public race", () => {
    expect(webLyricsProviders(true).map((provider) => provider.id)).toEqual([
      "Liner",
      "LRCMUX",
      "LRCLIB",
      "Lyrics.ovh",
    ]);
    expect(webLyricsProviders(false).map((provider) => provider.id)).toEqual([
      "LRCMUX",
      "LRCLIB",
      "Lyrics.ovh",
    ]);
  });

  it("declares Liner as the priority provider", () => {
    expect(linerLyricsProvider.topPriority).toBe(true);
    expect(linerLyricsProvider.priority).toBeLessThan(10);
  });
});
