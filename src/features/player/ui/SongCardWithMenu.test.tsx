import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import SongCardWithMenu from "./SongCardWithMenu";
import { usePlayerStore } from "../store/playerStore";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The UI barrel reaches the player signature, whose lottie build needs a real
// canvas; the card never plays an animation.
vi.mock("lottie-web/build/player/lottie_light", () => ({
  default: { loadAnimation: () => ({ destroy: () => undefined }) },
}));

// The artist barrel reaches the player signature (lottie), which needs a real
// canvas; the card only needs the link.
vi.mock("@/features/artist", () => ({
  ArtistLink: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("framer-motion", () => {
  const cache: Record<string, any> = {};
  return {
    AnimatePresence: ({ children }: any) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (!cache[prop]) {
            cache[prop] = React.forwardRef(
              ({ children, className, style, ...props }: any, ref: any) => {
                const cleanProps = { ...props };
                delete cleanProps.layout;
                delete cleanProps.layoutId;
                delete cleanProps.initial;
                delete cleanProps.animate;
                delete cleanProps.exit;
                delete cleanProps.transition;
                delete cleanProps.whileTap;
                delete cleanProps.whileHover;
                return React.createElement(
                  prop,
                  { ref, className, style, ...cleanProps },
                  children,
                );
              },
            );
          }
          return cache[prop];
        },
      },
    ),
  };
});

function clickCard(container: HTMLElement, detail = 1) {
  const card = container.querySelector<HTMLElement>("div.cursor-pointer");
  expect(card).not.toBeNull();
  act(() => {
    card!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  });
  return card!;
}

describe("SongCardWithMenu click latency", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    usePlayerStore.setState({ trackDoubleClickBehavior: "play" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    usePlayerStore.setState({ trackDoubleClickBehavior: "play" });
  });

  function renderCard(onPlay: () => void) {
    act(() => {
      root.render(
        <SongCardWithMenu
          id="track-1"
          title="One More Time"
          artists="Daft Punk"
          coverUrl=""
          onPlay={onPlay}
        />,
      );
    });
  }

  it("acts on the first click when a double click would do the same thing", () => {
    const onPlay = vi.fn();
    renderCard(onPlay);

    clickCard(container);

    // no timer window: the row must not sit still for 200 ms first
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("still waits for the second click when double click queues", () => {
    usePlayerStore.setState({ trackDoubleClickBehavior: "queue" });
    const onPlay = vi.fn();
    renderCard(onPlay);

    clickCard(container);
    expect(onPlay).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
