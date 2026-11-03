/**
 * "Use without an account".
 *
 * The app used to send every signed-out visitor to /login, which left no way
 * into the library when the API is unreachable. The flag is a one-way door for
 * the session: it only decides whether an anonymous visitor is allowed past the
 * login screen. Signing in clears it, so a later sign-out lands on /login again.
 */

export const GUEST_MODE_KEY = "liner_guest_mode";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function isGuestMode(): boolean {
  try {
    return storage()?.getItem(GUEST_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function enableGuestMode(): void {
  try {
    storage()?.setItem(GUEST_MODE_KEY, "1");
  } catch {}
}

export function clearGuestMode(): void {
  try {
    storage()?.removeItem(GUEST_MODE_KEY);
  } catch {}
}
