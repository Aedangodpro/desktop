/**
 * Hooks the browser shell installs for code the desktop runs natively.
 *
 * Innertube resolution lives in `shared/` because both targets use it, but a
 * browser has to relay requests through its own origin and mint its own PO
 * tokens, while Electron does both in the main process. Registering those two
 * capabilities keeps the shared module free of platform imports.
 */

export type RelayedFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PoTokenMinter = (identifier: string) => Promise<string>;

let relayedFetch: RelayedFetch | null = null;
let poTokenMinter: PoTokenMinter | null = null;

export function registerInnertubeFetch(fetchImpl: RelayedFetch | null): void {
  relayedFetch = fetchImpl;
}

export function registerPoTokenMinter(minter: PoTokenMinter | null): void {
  poTokenMinter = minter;
}

export function innertubeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return (relayedFetch ?? fetch)(input, init);
}

export function registeredPoTokenMinter(): PoTokenMinter | null {
  return poTokenMinter;
}
