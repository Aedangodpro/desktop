import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the browser shell bootstrap without a real browser: the same behaviors
 * that would otherwise need a Playwright run (runtime marker, splash dismissal,
 * file-drop guard) are observable in jsdom.
 */

function mountShell(): void {
  document.documentElement.removeAttribute("data-runtime");
  document.documentElement.removeAttribute("data-ready");
  document.body.innerHTML =
    '<div id="root"></div><div id="boot-splash"></div>';
}

function fileDropEvent(): Event {
  const event = new Event("drop", { cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"] },
  });
  return event;
}

const load = async () => {
  vi.resetModules();
  return import("./installWebRuntime");
};

beforeEach(() => {
  mountShell();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("installWebRuntime", () => {
  it("marks the document as the web shell", async () => {
    const { installWebRuntime } = await load();
    installWebRuntime();
    expect(document.documentElement.dataset.runtime).toBe("web");
  });

  it("prevents dropped files from navigating the tab away", async () => {
    const { installWebRuntime } = await load();
    installWebRuntime();

    const drop = fileDropEvent();
    window.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
  });

  it("leaves non-file drags alone so app drag-and-drop still works", async () => {
    const { installWebRuntime } = await load();
    installWebRuntime();

    const drop = new Event("drop", { cancelable: true });
    window.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
  });

  it("dismisses the boot splash once the app mounts", async () => {
    const { installWebRuntime } = await load();
    installWebRuntime();

    document.getElementById("root")?.appendChild(document.createElement("div"));

    await vi.waitFor(
      () => expect(document.documentElement.dataset.ready).toBe("true"),
      { timeout: 2000 },
    );
    await vi.waitFor(
      () => expect(document.getElementById("boot-splash")).toBeNull(),
      { timeout: 3000 },
    );
  });
});
