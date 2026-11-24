import { useSyncExternalStore } from "react";
import { getAuthSession } from "@/shared/api";

// short enough that a flaky request settles quickly; the old 1/3/8/20s ladder
// kept a resource "loading" for 32 seconds
const RETRY_DELAYS_MS = [600, 1_800];

function subscribe(onChange: () => void): () => void {
  window.addEventListener("auth:changed", onChange);
  return () => window.removeEventListener("auth:changed", onChange);
}

function ownerSnapshot(): string {
  return getAuthSession()?.user?.id ?? "";
}

export function useSessionOwner(): string {
  return useSyncExternalStore(subscribe, ownerSnapshot, ownerSnapshot);
}

function signedInSnapshot(): boolean {
  return Boolean(getAuthSession()?.accessToken);
}

/**
 * Whether the app has a session to call per-account endpoints with. Signed-out
 * visitors have nothing to load from `/v1/me/*`, so those resources stay idle
 * instead of answering with a 401 on every visit.
 */
export function useSessionSignedIn(): boolean {
  return useSyncExternalStore(subscribe, signedInSnapshot, () => false);
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return true;
  // 401/403 are answers, not hiccups: retrying them only delays the error state
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export async function loadWithRetry<T>(
  load: () => Promise<T>,
  isActive: () => boolean,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (err) {
      if (attempt >= delays.length || !isActive() || !isRetryable(err))
        throw err;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      if (!isActive()) throw err;
    }
  }
}
