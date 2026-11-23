/**
 * Tracks whether an element is actually on screen. `isWindowVisible()` only
 * knows about the document, so a page kept alive with `display: none` (route
 * Activity) or an off-screen panel still counts as visible there and keeps its
 * rAF loop running. This reports the element's own intersection state instead.
 *
 * The listener is called with the initial state, and defaults to visible when
 * IntersectionObserver is unavailable so a missing API never freezes an effect.
 */
export function observeElementVisible(
  element: Element,
  listener: (visible: boolean) => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    listener(true);
    return () => {};
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) listener(entry.isIntersecting);
    },
    { threshold: 0 },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
