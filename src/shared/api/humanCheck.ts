import { getApiBaseUrl } from "./baseUrl";

export type HumanCheckAction = "login" | "register";
export type HumanCheckMode = "off" | "optional" | "required";

export interface HumanCheckRequest {
  action: HumanCheckAction;
  mode: Exclude<HumanCheckMode, "off">;
}

export type HumanCheckPrompt = (
  request: HumanCheckRequest,
) => Promise<string | null>;

export class HumanCheckCancelledError extends Error {
  constructor() {
    super("The human check was closed.");
    this.name = "HumanCheckCancelledError";
  }
}

let prompt: HumanCheckPrompt | null = null;

export function setHumanCheckPrompt(next: HumanCheckPrompt | null): void {
  prompt = next;
}

export function humanCheckPageUrl(action: HumanCheckAction): string {
  return `${getApiBaseUrl()}/v1/auth/verify?action=${action}`;
}

export function humanCheckOrigin(): string {
  // The web build talks to a same-origin path (`/__liner`), which `new URL`
  // cannot parse without a base and would throw here. Resolve it against the
  // page origin; absolute bases keep behaving exactly as before.
  const base = getApiBaseUrl();
  const page =
    typeof window !== "undefined" && window.location?.href
      ? window.location.href
      : "http://localhost";
  return new URL(base, page).origin;
}

export function isHumanCheckMode(value: unknown): value is HumanCheckMode {
  return value === "off" || value === "optional" || value === "required";
}

export async function runHumanCheck(
  action: HumanCheckAction,
  mode: HumanCheckMode,
): Promise<string | undefined> {
  if (mode === "off") return undefined;
  const token = prompt ? await prompt({ action, mode }) : null;
  if (token) return token;
  if (mode === "required") throw new HumanCheckCancelledError();
  return undefined;
}
