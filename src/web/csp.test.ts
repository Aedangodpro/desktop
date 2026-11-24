import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../../vite.csp";

function directive(policy: string, name: string): string[] {
  const part = policy
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry === name || entry.startsWith(`${name} `));
  return part ? part.split(/\s+/).slice(1) : [];
}

/**
 * Sign-in renders the API's Turnstile page in an iframe. The web build serves
 * that page from its own origin (`/__liner/v1/auth/verify`), so `frame-src`
 * must include `'self'`: without it the browser refuses to frame the page and
 * the panel shows an empty white box while sign-in waits for a token that can
 * never be posted.
 */
describe("page content security policy", () => {
  it.each([
    ["production", false],
    ["development", true],
  ])("lets the page frame its own origin in %s", (_label, isDev) => {
    expect(directive(contentSecurityPolicy(isDev), "frame-src")).toContain(
      "'self'",
    );
  });

  it("keeps the remote API check page framable", () => {
    expect(directive(contentSecurityPolicy(false), "frame-src")).toContain(
      "https://*.tryliner.fun",
    );
  });
});
