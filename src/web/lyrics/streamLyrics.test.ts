import { describe, expect, it } from "vitest";
import type {
  LyricsCandidate,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";
import { raceLyricsProviders, streamLyricsEvents } from "./streamLyrics";
import type { LyricsProvider } from "./types";

function candidate(
  provider: string,
  syncLevel: LyricsSyncLevel,
  total = 80,
): LyricsCandidate {
  return {
    provider,
    contentKind:
      syncLevel === "syllable_level" || syncLevel === "word_level"
        ? "word_synced"
        : syncLevel === "line_level"
          ? "line_synced"
          : "plain",
    syncLevel,
    lyrics: {
      format: syncLevel === "plain" ? "plain" : "richsync",
      content: "[00:01.00]line",
    },
    quality: {
      total,
      match: 80,
      content: 80,
      sync: 80,
      source: 60,
      reasons: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function settleAfter<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const hint = { title: "Yellow", artist: "Coldplay" };

async function collect(
  providers: LyricsProvider[],
  options: {
    signal?: AbortSignal;
    onAttempt?: (provider: string) => void;
    graceMs?: number;
  } = {},
) {
  const events = [];
  for await (const event of streamLyricsEvents(
    hint,
    providers,
    options.signal,
    {
      onAttempt: options.onAttempt,
      graceMs: options.graceMs ?? 50,
    },
  )) {
    events.push(event);
  }
  return events;
}

describe("streamLyricsEvents", () => {
  it("streams every settled answer followed by a done event with the winner", async () => {
    const providers: LyricsProvider[] = [
      {
        id: "Polaris",
        priority: 10,
        maxSyncLevel: "line_level",
        fetchLyrics: async () => candidate("Polaris", "line_level", 88),
      },
      {
        id: "LRCLIB",
        priority: 20,
        maxSyncLevel: "line_level",
        fetchLyrics: async () => candidate("LRCLIB", "line_level", 78),
      },
    ];

    const events = await collect(providers);

    expect(events.map((event) => event.type)).toEqual([
      "provider",
      "provider",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Polaris", quality: 88, syncLevel: "line_level" },
    });
  });

  it("waits for a slow top-priority provider instead of settling on a decisive public answer", async () => {
    const liner = {
      ...candidate("Liner", "line_level", 70),
      topPriority: true,
    };
    const providers: LyricsProvider[] = [
      {
        id: "Liner",
        priority: 0,
        topPriority: true,
        maxSyncLevel: "syllable_level",
        fetchLyrics: () => settleAfter(liner, 200),
      },
      {
        id: "LRCMUX",
        priority: 10,
        maxSyncLevel: "word_level",
        fetchLyrics: async () => candidate("LRCMUX", "word_level", 95),
      },
    ];

    const events = await collect(providers, { graceMs: 30 });

    // the public word-level answer arrives first and would normally start the
    // grace window; the race must keep waiting for Liner anyway
    expect(
      events.some(
        (event) => event.type === "provider" && event.provider === "LRCMUX",
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Liner", syncLevel: "line_level" },
    });
  });

  it("reports the fastest answer first instead of waiting for the slowest", async () => {
    const slow = deferred<LyricsCandidate | null>();
    const fast = deferred<LyricsCandidate | null>();
    const providers: LyricsProvider[] = [
      { id: "Slow", priority: 10, fetchLyrics: () => slow.promise },
      { id: "Fast", priority: 20, fetchLyrics: () => fast.promise },
    ];

    const iterator = streamLyricsEvents(hint, providers, undefined, {
      graceMs: 50,
    })[Symbol.asyncIterator]();
    const first = iterator.next();
    fast.resolve(candidate("Fast", "line_level", 78));
    expect(await first).toMatchObject({
      value: { type: "provider", provider: "Fast", status: "found" },
    });

    const second = iterator.next();
    slow.resolve(candidate("Slow", "syllable_level", 95));
    expect(await second).toMatchObject({
      value: { type: "provider", provider: "Slow", status: "found" },
    });
    expect(await iterator.next()).toMatchObject({
      value: { type: "done", best: { provider: "Slow" } },
    });
  });

  it("ranks syllables above words even when the word answer arrives first", async () => {
    const providers: LyricsProvider[] = [
      {
        id: "Wordly",
        priority: 10,
        maxSyncLevel: "word_level",
        fetchLyrics: async () => candidate("Wordly", "word_level", 96),
      },
      {
        id: "Atlas",
        priority: 20,
        maxSyncLevel: "syllable_level",
        fetchLyrics: async () => candidate("Atlas", "syllable_level", 70),
      },
    ];

    const events = await collect(providers, { graceMs: 200 });

    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Atlas", syncLevel: "syllable_level", quality: 70 },
    });
  });

  it("lets a delayed syllable answer beat an early word answer inside the grace window", async () => {
    const providers: LyricsProvider[] = [
      {
        id: "Wordly",
        priority: 10,
        maxSyncLevel: "word_level",
        fetchLyrics: async () => candidate("Wordly", "word_level", 76),
      },
      {
        id: "Atlas",
        priority: 20,
        maxSyncLevel: "syllable_level",
        fetchLyrics: () =>
          settleAfter(candidate("Atlas", "syllable_level", 95), 40),
      },
    ];

    const events = await collect(providers, { graceMs: 200 });

    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Atlas", quality: 95 },
    });
  });

  it("settles on the word answer once the grace window expires", async () => {
    let lateSignal: AbortSignal | undefined;
    const providers: LyricsProvider[] = [
      {
        id: "Wordly",
        priority: 10,
        maxSyncLevel: "word_level",
        fetchLyrics: async () => candidate("Wordly", "word_level", 76),
      },
      {
        id: "Atlas",
        priority: 20,
        maxSyncLevel: "syllable_level",
        fetchLyrics: (_hint, signal) => {
          lateSignal = signal;
          return settleAfter(candidate("Atlas", "syllable_level", 95), 200);
        },
      },
    ];

    const events = await collect(providers, { graceMs: 30 });

    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Wordly" },
    });
    expect(lateSignal?.aborted).toBe(true);
  });

  it("keeps a word answer over a line answer that arrived first", async () => {
    const providers: LyricsProvider[] = [
      {
        id: "Lines",
        priority: 10,
        maxSyncLevel: "line_level",
        fetchLyrics: async () => candidate("Lines", "line_level", 95),
      },
      {
        id: "Words",
        priority: 20,
        maxSyncLevel: "word_level",
        fetchLyrics: async () => candidate("Words", "word_level", 70),
      },
    ];

    const events = await collect(providers);

    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Words", syncLevel: "word_level" },
    });
  });

  it("aborts lower tiers as soon as a word answer lands", async () => {
    let lineSignal: AbortSignal | undefined;
    const providers: LyricsProvider[] = [
      {
        id: "Words",
        priority: 10,
        maxSyncLevel: "word_level",
        fetchLyrics: async () => candidate("Words", "word_level", 88),
      },
      {
        id: "Lines",
        priority: 20,
        maxSyncLevel: "line_level",
        fetchLyrics: (_hint, signal) => {
          lineSignal = signal;
          return new Promise<LyricsCandidate | null>(() => {});
        },
      },
    ];

    const started = performance.now();
    const events = await collect(providers, { graceMs: 800 });

    expect(performance.now() - started).toBeLessThan(300);
    expect(lineSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Words", syncLevel: "word_level" },
    });
  });

  it("keeps waiting for an equal tier that could win on quality", async () => {
    const providers: LyricsProvider[] = [
      {
        id: "Lines",
        priority: 10,
        maxSyncLevel: "line_level",
        fetchLyrics: async () => candidate("Lines", "line_level", 70),
      },
      {
        id: "Better",
        priority: 20,
        maxSyncLevel: "line_level",
        fetchLyrics: () =>
          settleAfter(candidate("Better", "line_level", 90), 30),
      },
    ];

    const events = await collect(providers);

    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Better", quality: 90 },
    });
  });

  it("falls back to the next provider when one times out", async () => {
    const providers: LyricsProvider[] = [
      {
        id: "Hangs",
        priority: 10,
        timeoutMs: 20,
        fetchLyrics: () => new Promise<LyricsCandidate | null>(() => {}),
      },
      {
        id: "Lines",
        priority: 20,
        maxSyncLevel: "line_level",
        fetchLyrics: async () => candidate("Lines", "line_level", 82),
      },
    ];

    const events = await collect(providers);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider",
        provider: "Hangs",
        status: "error",
        message: "timed out",
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Lines" },
    });
  });

  it("asks plain-only providers only when nothing synced was found", async () => {
    const attempted: string[] = [];
    const providers: LyricsProvider[] = [
      {
        id: "Synced",
        priority: 10,
        maxSyncLevel: "line_level",
        fetchLyrics: async () => candidate("Synced", "line_level", 80),
      },
      {
        id: "Plain",
        priority: 40,
        tier: "plain",
        maxSyncLevel: "plain",
        fetchLyrics: async () => candidate("Plain", "plain", 40),
      },
    ];

    const events = await collect(providers, {
      onAttempt: (id) => attempted.push(id),
    });

    expect(attempted).toEqual(["Synced"]);
    expect(
      events.some(
        (event) => event.type === "provider" && event.provider === "Plain",
      ),
    ).toBe(false);
  });

  it("falls through to plain providers when every synced source misses", async () => {
    const attempted: string[] = [];
    const providers: LyricsProvider[] = [
      {
        id: "Synced",
        priority: 10,
        maxSyncLevel: "line_level",
        fetchLyrics: async () => null,
      },
      {
        id: "Plain",
        priority: 40,
        tier: "plain",
        maxSyncLevel: "plain",
        fetchLyrics: async () => candidate("Plain", "plain", 40),
      },
    ];

    const events = await collect(providers, {
      onAttempt: (id) => attempted.push(id),
    });

    expect(attempted).toEqual(["Synced", "Plain"]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Plain", syncLevel: "plain" },
    });
  });

  it("reports transport failures as error events and still finishes", async () => {
    const providers: LyricsProvider[] = [
      {
        id: "Broken",
        priority: 10,
        fetchLyrics: async () => {
          throw new Error("network down");
        },
      },
      {
        id: "Lines",
        priority: 20,
        maxSyncLevel: "line_level",
        fetchLyrics: async () => candidate("Lines", "line_level", 80),
      },
    ];

    const events = await collect(providers);

    expect(events[0]).toMatchObject({
      type: "provider",
      provider: "Broken",
      status: "error",
      message: "network down",
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      best: { provider: "Lines" },
    });
  });

  it("reports not_found when no provider has lyrics", async () => {
    const events = await collect([
      { id: "A", priority: 10, fetchLyrics: async () => null },
      { id: "B", priority: 20, fetchLyrics: async () => null },
    ]);

    expect(events).toEqual([
      { type: "provider", provider: "A", status: "not_found" },
      { type: "provider", provider: "B", status: "not_found" },
      { type: "done", cached: false, status: "not_found" },
    ]);
  });
});

describe("raceLyricsProviders", () => {
  it("starts every provider before any of them settles", async () => {
    const started: string[] = [];
    const stalled = () => new Promise<LyricsCandidate | null>(() => {});
    const providers: LyricsProvider[] = [
      {
        id: "A",
        priority: 10,
        fetchLyrics: () => {
          started.push("A");
          return stalled();
        },
      },
      {
        id: "B",
        priority: 20,
        fetchLyrics: () => {
          started.push("B");
          return stalled();
        },
      },
    ];

    const controller = new AbortController();
    const iterator = raceLyricsProviders(providers, hint, controller.signal)[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();
    await Promise.resolve();

    expect(started).toEqual(["A", "B"]);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels the outstanding providers when the consumer stops", async () => {
    let slowSignal: AbortSignal | undefined;
    const started = new AbortController();
    const providers: LyricsProvider[] = [
      {
        id: "Fast",
        priority: 10,
        fetchLyrics: async () => candidate("Fast", "line_level", 80),
      },
      {
        id: "Slow",
        priority: 20,
        fetchLyrics: (_hint, signal) => {
          slowSignal = signal;
          return new Promise<LyricsCandidate | null>(() => {});
        },
      },
    ];

    for await (const _outcome of raceLyricsProviders(
      providers,
      hint,
      started.signal,
    )) {
      break;
    }

    expect(slowSignal?.aborted).toBe(true);
  });
});
