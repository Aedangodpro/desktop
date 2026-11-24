/**
 * Bounded caches for the pure text normalisers the matchers lean on.
 *
 * Matching one search result set against a track runs the same handful of
 * strings through `cleanBaseTitle`, `normalizeWords` and `toPhoneticLatin`
 * hundreds of times: the query is constant, and every candidate's title and
 * artist are normalised once per comparison against every other candidate. That
 * repeated work is what made the SoundCloud merge in catalog search cost ~30 ms
 * of main thread on a keystroke (see `matchingCost.test.ts`).
 *
 * These functions are pure and their inputs are titles and artist names, so a
 * small cache is safe. The cap keeps memory flat on a long session; eviction is
 * insertion order, which is good enough for a working set of one screen of
 * results.
 */
export function memoizeText<T>(
  compute: (value: string) => T,
  limit = 512,
): (value: string) => T {
  const cache = new Map<string, T>();
  return (value: string): T => {
    const hit = cache.get(value);
    if (hit !== undefined) return hit;
    const result = compute(value);
    if (cache.size >= limit) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(value, result);
    return result;
  };
}

/** exported for tests: the shared caches never keep more than `limit` entries */
export function memoSize(limit: number, fill: number): number {
  const cache = new Map<string, number>();
  for (let index = 0; index < fill; index += 1) {
    if (cache.size >= limit) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(`key-${index}`, index);
  }
  return cache.size;
}
