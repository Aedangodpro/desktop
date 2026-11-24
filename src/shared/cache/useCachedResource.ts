import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  notifyScreenCache,
  readScreenCache,
  subscribeScreenCache,
  touchScreenCache,
  writeScreenCache,
} from "./screenCache";

export interface CachePolicy {
  isFresh: (savedAt: number) => boolean;
  maxAgeMs?: number;
  revalidateOnFocus?: boolean;
  sessionOnly?: boolean;
  /**
   * False keeps the resource from requesting anything. Per-account endpoints
   * are useless without a session: loading them anyway is what sent signed-out
   * visitors to `/v1/me/history` and `/v1/me/recommendations` and collected a
   * 401 for every visit.
   */
  enabled?: boolean;
}

export function freshFor(ms: number): (savedAt: number) => boolean {
  return (savedAt) => Date.now() - savedAt < ms;
}

const inFlight = new Map<string, Promise<void>>();
const failedKeys = new Set<string>();
const queuedKeys = new Set<string>();

function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function revalidateResource<T>(
  key: string,
  load: () => Promise<T>,
  options: { force?: boolean; persist?: boolean } = {},
): Promise<void> {
  const persist = options.persist ?? true;
  const running = inFlight.get(key);
  if (running) {
    if (!options.force || queuedKeys.has(key)) return running;
    queuedKeys.add(key);
    return running.then(() => {
      queuedKeys.delete(key);
      return revalidateResource(key, load, { persist });
    });
  }
  const task = load()
    .then((data) => {
      const wasFailed = failedKeys.delete(key);
      const current = readScreenCache<T>(key);
      const comparable = current && (persist || current.sessionOnly);
      if (comparable && sameData(current.data, data)) {
        touchScreenCache(key);
        if (wasFailed) notifyScreenCache(key);
        return;
      }
      writeScreenCache(key, data, { persist });
    })
    .catch(() => {
      if (failedKeys.has(key)) return;
      failedKeys.add(key);
      notifyScreenCache(key);
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
}

export function useCachedResource<T>(
  key: string,
  load: () => Promise<T>,
  policy: CachePolicy,
): { data: T | undefined; isLoading: boolean } {
  const loadRef = useRef(load);
  loadRef.current = load;
  const policyRef = useRef(policy);
  policyRef.current = policy;

  const subscribe = useCallback(
    (listener: () => void) => subscribeScreenCache(key, listener),
    [key],
  );
  const entry = useSyncExternalStore(subscribe, () => readScreenCache<T>(key));
  const failed = useSyncExternalStore(subscribe, () => failedKeys.has(key));

  useEffect(() => {
    if (policyRef.current.enabled === false) return;
    const check = () => {
      const { isFresh, sessionOnly } = policyRef.current;
      const current = readScreenCache(key);
      const usableNow = current && (!sessionOnly || current.sessionOnly);
      if (!usableNow || !isFresh(current.savedAt)) {
        void revalidateResource(key, () => loadRef.current(), {
          persist: !sessionOnly,
        });
      }
    };
    check();
    if (!policyRef.current.revalidateOnFocus) return;
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [key, policy.enabled]);

  const usable =
    entry &&
    (!policy.sessionOnly || entry.sessionOnly) &&
    (!policy.maxAgeMs || Date.now() - entry.savedAt <= policy.maxAgeMs)
      ? entry
      : undefined;
  const enabled = policy.enabled ?? true;
  return {
    data: usable?.data,
    isLoading: enabled ? !usable && !failed : false,
  };
}
