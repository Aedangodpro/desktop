/**
 * Node 26 exposes an experimental `localStorage` global that only works with
 * `--localstorage-file`; without it the value is undefined and shadows jsdom's,
 * so any test touching the bare identifier throws. Vitest's `globalThis` is the
 * jsdom window, so re-pointing the property at `window.localStorage` recursed.
 * Install a plain in-memory Storage instead, which is all these suites need.
 */
function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      const value = store.get(String(key));
      return value === undefined ? null : value;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(String(key));
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  } as Storage;
}

function isUsable(storage: unknown): boolean {
  try {
    return (
      !!storage &&
      typeof (storage as Storage).setItem === "function" &&
      typeof (storage as Storage).getItem === "function"
    );
  } catch {
    return false;
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (isUsable(globalThis[name])) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: createStorage(),
  });
}
