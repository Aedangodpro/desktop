/**
 * Browser shell bootstrap.
 *
 * Runs before the React root is created. Everything here is deliberately
 * concern-free: it never touches application state, it only adapts the document
 * to behave like an application window instead of a page.
 */

const SPLASH_ID = "boot-splash";
const SPLASH_SAFETY_TIMEOUT_MS = 12_000;

let installed = false;

function dismissBootSplash(): void {
  const splash = document.getElementById(SPLASH_ID);
  if (!splash) return;

  // `data-ready` fades the splash out in CSS; removing the node afterwards keeps
  // it out of the accessibility tree and out of hit-testing.
  document.documentElement.dataset.ready = "true";
  window.setTimeout(() => splash.setAttribute("aria-hidden", "true"), 280);
  window.setTimeout(() => splash.remove(), 900);
}

function dismissSplashOnFirstPaint(): void {
  const root = document.getElementById("root");
  if (!root) return;
  if (root.childElementCount > 0) {
    dismissBootSplash();
    return;
  }

  const observer = new MutationObserver(() => {
    if (root.childElementCount === 0) return;
    observer.disconnect();
    dismissBootSplash();
  });
  observer.observe(root, { childList: true });

  // Safety net: a failed mount must not leave the user staring at a splash.
  window.setTimeout(() => {
    observer.disconnect();
    dismissBootSplash();
  }, SPLASH_SAFETY_TIMEOUT_MS);
}

/**
 * Dropping a file onto a page makes the browser navigate to it, which unmounts
 * the whole app and loses playback state. Desktop apps never do that.
 */
function blockFileNavigation(): void {
  const carriesFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  window.addEventListener("dragover", (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
}

export function installWebRuntime(): void {
  if (installed) return;
  installed = true;

  document.documentElement.setAttribute("data-runtime", "web");
  blockFileNavigation();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", dismissSplashOnFirstPaint, {
      once: true,
    });
  } else {
    dismissSplashOnFirstPaint();
  }

  // Restoring from the back/forward cache must not replay the splash.
  window.addEventListener("pageshow", () => {
    document.documentElement.dataset.ready = "true";
    document.getElementById(SPLASH_ID)?.remove();
  });
}
