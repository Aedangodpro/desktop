/**
 * Tracks whether an element is actually on screen. `isWindowVisible()` only
 * knows about the document, so a page kept alive with `display: none` (route
 * Activity) or an off-screen panel still counts as visible there and keeps its
 * rAF loop running. This reports the element's own intersection state instead.
 *
 * The listener is called with the initial state, and defaults to visible when
 * IntersectionObserver is unavailable so a missing API never freezes an effect.
 *
 * "Hidden" is debounced: during a slide or fade the element is briefly outside
 * the viewport (the fullscreen player enters from y: 100%), and pausing on that
 * first frame would freeze a lyric or background loop just as it becomes
 * visible. A visible report is immediate.
 */
export interface ElementVisibilityOptions {
  /** How long the element must stay out of view before `false` is reported. */
  hideDelayMs?: number;
}

export const ELEMENT_HIDE_DELAY_MS = 400;

export function observeElementVisible(
  element: Element,
  listener: (visible: boolean) => void,
  { hideDelayMs = ELEMENT_HIDE_DELAY_MS }: ElementVisibilityOptions = {},
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    listener(true);
    return () => {};
  }
  let visible = true;
  let hideTimer = 0;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          window.clearTimeout(hideTimer);
          hideTimer = 0;
          if (visible) continue;
          visible = true;
          listener(true);
          continue;
        }
        if (!visible || hideTimer) continue;
        hideTimer = window.setTimeout(() => {
          hideTimer = 0;
          if (visible) {
            visible = false;
            listener(false);
          }
        }, hideDelayMs);
      }
    },
    { threshold: 0 },
  );
  observer.observe(element);
  return () => {
    window.clearTimeout(hideTimer);
    observer.disconnect();
  };
}
