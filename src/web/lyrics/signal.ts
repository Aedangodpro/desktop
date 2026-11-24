/**
 * A timeout signal that works in every browser the app supports.
 *
 * `AbortSignal.timeout` and `AbortSignal.any` are recent (Safari 17.4+, Chrome
 * 116+). On older iOS Safari they do not exist, and the provider code used to
 * call them unguarded, so every lyrics request threw before it reached the
 * network. This helper only uses `AbortController`, which is universally
 * available, and still reports whether the deadline or the caller fired.
 */

export interface ScopedSignal {
  signal: AbortSignal;
  /** True when the deadline aborted the scope, not the caller. */
  timedOut: () => boolean;
  /** Clears the timer and the parent listener; always call it. */
  dispose: () => void;
}

export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): ScopedSignal {
  const controller = new AbortController();
  let timedOut = false;

  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException("The request timed out.", "TimeoutError"),
    );
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}
