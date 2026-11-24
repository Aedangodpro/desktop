import type {
  LyricsCandidate,
  LyricsStreamEvent,
} from "@/shared/contracts/lyrics";
import { SYNC_DEPTH, isDecisiveCandidate, preferCandidate } from "./ranking";
import { withTimeout } from "./signal";
import type { LyricsHint, LyricsProvider } from "./types";

/**
 * Runs every provider the app knows about as a race, in the same shape the
 * Liner API streams from `/v1/tracks/:id/lyrics`:
 *
 *   metadata -> provider* -> done
 *
 * Providers start together and report as they settle, so the first answer is
 * painted instead of waiting out the slowest source. Completion follows the
 * ranking order (`syllable > word > line > plain`):
 *
 * - while a provider that could still return an equal or richer tier is in
 *   flight, the race keeps waiting for it;
 * - once a decisive (word-or-better) answer is the best so far and only lower
 *   tiers are outstanding, they are aborted immediately;
 * - when a provider of the same or a higher tier is still out there, a short
 *   grace window gives it the chance to land before the race settles. A late
 *   syllable answer therefore beats an early word one instead of being aborted.
 *
 * If nobody has timing, unsynced sources (`tier: "plain"`) are asked only
 * then, which is the fallback chain: syllable -> word -> line -> plain.
 */

const PROVIDER_TIMEOUT_MS = 9_000;
/** How long a decisive answer waits for an equal or richer tier still in flight. */
export const DEFAULT_GRACE_MS = 800;

export interface ProviderOutcome {
  provider: string;
  status: "found" | "not_found" | "error";
  candidate?: LyricsCandidate;
  message?: string;
}

export interface StreamLyricsOptions {
  /** Called as each provider is started (used for diagnostics and tests). */
  onAttempt?: (provider: string) => void;
  /** Override the grace window (tests use a short one). */
  graceMs?: number;
}

interface RaceState {
  best: LyricsCandidate | null;
}

/**
 * Whether a provider that has not answered yet could still beat `best`. An
 * equal tier can win on quality, so only strictly lower tiers are hopeless.
 * A provider that does not declare `maxSyncLevel` is treated as able to return
 * syllables, because aborting it could throw away a richer answer.
 */
function canStillBeat(
  provider: LyricsProvider,
  best: LyricsCandidate,
): boolean {
  const ceiling = SYNC_DEPTH[provider.maxSyncLevel ?? "syllable_level"];
  return ceiling >= (SYNC_DEPTH[best.syncLevel] ?? 0);
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("Lyrics streaming was aborted.", "AbortError")
  );
}

async function runProvider(
  provider: LyricsProvider,
  hint: LyricsHint,
  signal: AbortSignal,
): Promise<ProviderOutcome> {
  const scope = withTimeout(signal, provider.timeoutMs ?? PROVIDER_TIMEOUT_MS);

  try {
    // A provider that ignores the abort signal must still lose the race at its
    // deadline instead of holding the whole group open forever.
    const work = provider.fetchLyrics(hint, scope.signal);
    work.catch(() => undefined);
    const candidate = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const fail = () => reject(new Error("timed out"));
        scope.signal.addEventListener("abort", fail, { once: true });
        if (scope.signal.aborted) fail();
      }),
    ]);
    if (candidate?.lyrics?.content) {
      return { provider: provider.id, status: "found", candidate };
    }
    return { provider: provider.id, status: "not_found" };
  } catch (error) {
    const message = scope.timedOut()
      ? "timed out"
      : signal.aborted
        ? "cancelled"
        : error instanceof Error
          ? error.message
          : String(error);
    return { provider: provider.id, status: "error", message };
  } finally {
    scope.dispose();
  }
}

/**
 * Yields one outcome per provider, in the order they settle. The generator
 * aborts every remaining request when the consumer stops iterating, which is
 * how a decisive answer cancels the rest of the race.
 */
export async function* raceLyricsProviders(
  providers: LyricsProvider[],
  hint: LyricsHint,
  signal?: AbortSignal,
  options: StreamLyricsOptions = {},
): AsyncGenerator<ProviderOutcome> {
  if (providers.length === 0) return;
  if (signal?.aborted) throw abortReason(signal);

  const controller = new AbortController();
  const queue: ProviderOutcome[] = [];
  let wake: (() => void) | null = null;
  let pending = providers.length;

  // an abort must also wake the generator when no provider has settled yet
  const forwardAbort = () => {
    controller.abort();
    const resume = wake;
    wake = null;
    resume?.();
  };
  signal?.addEventListener("abort", forwardAbort, { once: true });

  const settle = (outcome: ProviderOutcome) => {
    pending -= 1;
    queue.push(outcome);
    const resume = wake;
    wake = null;
    resume?.();
  };

  for (const provider of [...providers].sort(
    (a, b) => a.priority - b.priority,
  )) {
    options.onAttempt?.(provider.id);
    void runProvider(provider, hint, controller.signal).then(settle);
  }

  try {
    while (pending > 0 || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        if (signal?.aborted) throw abortReason(signal);
        continue;
      }
      yield queue.shift()!;
    }
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function* consumeGroup(
  group: LyricsProvider[],
  hint: LyricsHint,
  signal: AbortSignal | undefined,
  options: StreamLyricsOptions,
  state: RaceState,
): AsyncGenerator<LyricsStreamEvent> {
  // The race's own generator can only be closed once its pending next() call
  // settles, and a provider that never answers would hold that open. Aborting
  // this group signal cancels the providers first, so the close is immediate.
  const groupAbort = new AbortController();
  const forwardAbort = () => groupAbort.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });

  const iterator = raceLyricsProviders(group, hint, groupAbort.signal, options)[
    Symbol.asyncIterator
  ]();
  const providersById = new Map(
    group.map((provider) => [provider.id, provider]),
  );
  const remaining = new Set(providersById.keys());

  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let gracePromise: Promise<void> | null = null;
  const startGrace = () => {
    if (gracePromise) return;
    gracePromise = new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, options.graceMs ?? DEFAULT_GRACE_MS);
    });
  };

  try {
    while (true) {
      const pending = iterator.next();
      // the cast keeps control-flow analysis from treating a promise assigned
      // inside startGrace() as permanently null
      const grace = gracePromise as Promise<void> | null;
      let result:
        | { kind: "outcome"; value: IteratorResult<ProviderOutcome> }
        | { kind: "grace" };
      if (grace) {
        result = await Promise.race([
          pending.then((value) => ({ kind: "outcome" as const, value })),
          grace.then(() => ({ kind: "grace" as const })),
        ]);
      } else {
        result = { kind: "outcome", value: await pending };
      }

      if (result.kind === "grace") {
        // the grace deadline won; the outstanding next() is abandoned with the
        // rest of the race in the finally block below
        pending.catch(() => undefined);
        break;
      }

      if (result.value.done) break;
      const outcome = result.value.value;
      remaining.delete(outcome.provider);

      if (outcome.status === "found" && outcome.candidate) {
        const candidate = outcome.candidate;
        if (!state.best || preferCandidate(candidate, state.best)) {
          state.best = candidate;
        }
        yield {
          type: "provider",
          provider: outcome.provider,
          status: "found",
          syncLevel: candidate.syncLevel,
          candidate,
          ...(hint.durationMs ? { durationMs: hint.durationMs } : {}),
        };

        const best = state.best;
        if (best) {
          const couldBeat = [...remaining].some((id) => {
            const provider = providersById.get(id);
            return provider ? canStillBeat(provider, best) : true;
          });
          // every outstanding provider is a lower tier: nothing left can win
          if (!couldBeat) break;
          // The Liner API is the intended primary source. While it is still in
          // flight, do not let a fast public answer settle the race (a decisive
          // word-level answer would otherwise start the 800 ms grace and abort
          // Liner before the proxy answers).
          const priorityPending = [...remaining].some(
            (id) => providersById.get(id)?.topPriority,
          );
          if (priorityPending && !best.topPriority) continue;
          // a per-word answer waits a moment for a possible syllable answer;
          // a priority answer only waits for the alternates that already landed
          if (isDecisiveCandidate(best) || best.topPriority) startGrace();
        }
      } else if (outcome.status === "error") {
        yield {
          type: "provider",
          provider: outcome.provider,
          status: "error",
          message: outcome.message ?? "provider failed",
          ...(hint.durationMs ? { durationMs: hint.durationMs } : {}),
        };
      } else {
        yield {
          type: "provider",
          provider: outcome.provider,
          status: "not_found",
          ...(hint.durationMs ? { durationMs: hint.durationMs } : {}),
        };
      }
    }
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
    groupAbort.abort();
    signal?.removeEventListener("abort", forwardAbort);
    await iterator.return?.(undefined);
  }
}

export async function* streamLyricsEvents(
  hint: LyricsHint,
  providers: LyricsProvider[],
  signal?: AbortSignal,
  options: StreamLyricsOptions = {},
): AsyncGenerator<LyricsStreamEvent> {
  const ordered = [...providers].sort((a, b) => a.priority - b.priority);
  const synced = ordered.filter((provider) => provider.tier !== "plain");
  const plainOnly = ordered.filter((provider) => provider.tier === "plain");

  const state: RaceState = { best: null };

  for (const group of [synced, plainOnly]) {
    if (group.length === 0) continue;
    // unsynced text is only a fallback: once anything is timed, stop here
    if (group === plainOnly && state.best) break;
    yield* consumeGroup(group, hint, signal, options, state);
  }

  const best = state.best;
  yield best
    ? {
        type: "done",
        cached: false,
        best: {
          provider: best.provider,
          quality: best.quality.total,
          syncLevel: best.syncLevel,
        },
      }
    : { type: "done", cached: false, status: "not_found" };
}
