import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemesTab } from "./ThemesTab";

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  stubMatchMedia();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemesTab", () => {
  it("writes the selected accent to both variable families", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ThemeProvider attribute="data-theme">
          <ThemesTab />
        </ThemeProvider>,
      );
    });

    const ocean = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Ocean"),
    );
    expect(ocean).toBeTruthy();

    await act(async () => {
      (ocean as HTMLButtonElement).click();
    });

    const style = document.documentElement.style;
    expect(style.getPropertyValue("--accent-primary")).toBe("#2f80ed");
    expect(style.getPropertyValue("--color-accent-primary")).toBe("#2f80ed");
    expect(style.getPropertyValue("--accent-secondary")).toBe("#56a0f5");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
