import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiTrack } from "@/shared/api";
import { toClientTrack } from "@/shared/api";
import type { ApiSearchItem } from "@/shared/api";
import type { Track } from "@/shared/types";

export interface UseSearchTracksOptions {
  enabled?: boolean;
  limit?: number;
  debounceMs?: number;
}

export interface UseSearchTracksResult {
  tracks: Track[];
  loading: boolean;
  hasLoaded: boolean;
  error: Error | null;
  partialWarning?: string;
  runNow: () => void;
}

function toTracks(items: ApiSearchItem[]): Track[] {
  return items
    .filter((it): it is ApiTrack & { type: "track" } => it.type === "track")
    .map(toClientTrack);
}

export function useSearchTracks(
  query: string,
  options: UseSearchTracksOptions = {},
): UseSearchTracksResult {
  const { enabled = true, debounceMs = 250 } = options;
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [partialWarning, setPartialWarning] = useState<string | undefined>();

  const latestRequestIdRef = useRef(0);
  const lastFetchedQueryRef = useRef("");
  // only the newest query's lookup keeps running
  const abortRef = useRef<AbortController | null>(null);
  const trimmed = query.trim();
  const shouldRunSearch = enabled && trimmed.length >= 2;

  const runRequest = useCallback(async (requestId: number, q: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await api.search(q, "track", {
        signal: controller.signal,
        onPrimary: (primary) => {
          if (requestId !== latestRequestIdRef.current) return;
          setTracks(toTracks(primary));
          setError(null);
          setPartialWarning(undefined);
          lastFetchedQueryRef.current = q;
          setHasLoaded(true);
          setLoading(false);
        },
      });
      if (requestId !== latestRequestIdRef.current) return;
      setTracks(toTracks(res.items));
      setError(null);
      setPartialWarning(undefined);
      lastFetchedQueryRef.current = q;
      setHasLoaded(true);
    } catch (err) {
      if (requestId !== latestRequestIdRef.current) return;
      setTracks([]);
      setError(err instanceof Error ? err : new Error(String(err)));
      setPartialWarning(undefined);
      setHasLoaded(true);
    } finally {
      if (requestId === latestRequestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (trimmed.length < 2) {
      latestRequestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setTracks([]);
      setHasLoaded(false);
      setLoading(false);
      setError(null);
      setPartialWarning(undefined);
      lastFetchedQueryRef.current = "";
      return;
    }

    if (!enabled) return;

    if (lastFetchedQueryRef.current === trimmed && tracks.length > 0) {
      setLoading(false);
      setHasLoaded(true);
      return;
    }

    setLoading(true);
    const requestId = ++latestRequestIdRef.current;
    const timer = setTimeout(() => {
      if (lastFetchedQueryRef.current === trimmed && tracks.length > 0) {
        setLoading(false);
        setHasLoaded(true);
        return;
      }
      void runRequest(requestId, trimmed);
    }, debounceMs);

    return () => {
      clearTimeout(timer);
    };
  }, [debounceMs, enabled, runRequest, tracks.length, trimmed]);

  const runNow = useCallback(() => {
    if (!shouldRunSearch) return;
    const requestId = ++latestRequestIdRef.current;
    void runRequest(requestId, trimmed);
  }, [runRequest, shouldRunSearch, trimmed]);

  return { tracks, loading, hasLoaded, error, partialWarning, runNow };
}
