import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildAmbientWorkerSource } from "./ambientWorkerSource";

function fakeContext() {
  const calls = {
    fillRect: 0,
    clearRect: 0,
    drawImage: 0,
    gradients: 0,
    composite: [] as string[],
  };
  const gradient = { addColorStop: () => {} };
  const ctx = {
    fillStyle: "",
    globalCompositeOperation: "source-over",
    fillRect: () => calls.fillRect++,
    clearRect: () => calls.clearRect++,
    drawImage: () => calls.drawImage++,
    save: () => {},
    restore: () => {},
    createLinearGradient: () => {
      calls.gradients++;
      return gradient;
    },
    createRadialGradient: () => {
      calls.gradients++;
      return gradient;
    },
  };
  return { ctx, calls };
}

function fakeCanvas() {
  const { ctx, calls } = fakeContext();
  return { width: 300, height: 200, getContext: () => ctx, calls, ctx };
}

function runWorker(script: string, offscreen = true) {
  const posted: Record<string, unknown>[] = [];
  const frames: ((now: number) => void)[] = [];
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return fakeContext().ctx;
    }
  }
  const self: Record<string, unknown> = {
    postMessage: (message: Record<string, unknown>) => posted.push(message),
    requestAnimationFrame: (callback: (now: number) => void) =>
      frames.push(callback),
  };
  if (offscreen) self.OffscreenCanvas = FakeOffscreenCanvas;
  self.self = self;
  vm.runInNewContext(buildAmbientWorkerSource(script), self);
  const send = (data: Record<string, unknown>) =>
    (self.onmessage as (event: { data: unknown }) => void)({ data });
  const step = (count: number, stepMs = 16) => {
    for (let index = 0; index < count; index++) frames.shift()?.(index * stepMs);
  };
  return { posted, send, step };
}

describe("ambient worker runtime", () => {
  it("runs the effect, reports its options and keeps drawing frames", () => {
    const worker = runWorker(
      "ambient((canvas) => { let n = 0; return { pixelated: true, scale: 0.3, blur: 6, fps: 60, frame() { canvas.frames = ++n; } }; });",
    );
    const canvas = fakeCanvas() as ReturnType<typeof fakeCanvas> & {
      frames?: number;
    };
    worker.send({ type: "init", canvas, info: { width: 300, height: 200 } });
    worker.step(5);
    expect(worker.posted[0]).toEqual({
      type: "options",
      pixelated: true,
      scale: 0.3,
      blur: 6,
    });
    expect(canvas.frames).toBeGreaterThan(0);
  });

  it("caps an effect that asks for 60 fps at 30 fps", () => {
    const worker = runWorker(
      "ambient((canvas) => { let n = 0; return { fps: 60, frame() { canvas.frames = ++n; } }; });",
    );
    const canvas = fakeCanvas() as ReturnType<typeof fakeCanvas> & {
      frames?: number;
    };
    worker.send({ type: "init", canvas, info: {} });
    worker.step(7);
    // 16 ms steps at a 30 fps cap: draws at 0, 16, 48 and 80 ms. Uncapped,
    // every tick renders, so the count would be 7.
    expect(canvas.frames).toBe(4);
  });

  it("bakes the host mask into the surface once per frame", () => {
    const worker = runWorker(
      "ambient((canvas) => { let n = 0; return { fps: 60, frame() { canvas.frames = ++n; } }; });",
    );
    const canvas = fakeCanvas();
    worker.send({
      type: "init",
      canvas,
      info: {},
      mask: {
        fadeStart: 0.3,
        fadeEnd: 0.62,
        fadeEndAlpha: 0.12,
        hole: { x: 0.5, y: 0.5, inner: 0.1, outer: 0.2 },
      },
    });
    worker.step(4);
    expect(canvas.calls.drawImage).toBeGreaterThan(0);
  });

  it("skips the mask when the runtime has no OffscreenCanvas", () => {
    const worker = runWorker(
      "ambient(() => ({ fps: 60, frame() {} }));",
      false,
    );
    const canvas = fakeCanvas();
    worker.send({
      type: "init",
      canvas,
      info: {},
      mask: { fadeStart: 0.3, fadeEnd: 0.62, fadeEndAlpha: 0.12, hole: null },
    });
    worker.step(4);
    expect(canvas.calls.drawImage).toBe(0);
  });

  it("stops and reports when the effect throws or never calls ambient()", () => {
    const broken = runWorker(
      "ambient(() => ({ fps: 60, frame() { throw new Error('boom'); } }));",
    );
    broken.send({ type: "init", canvas: fakeCanvas(), info: {} });
    broken.step(3);
    expect(broken.posted).toContainEqual({ type: "error", message: "boom" });

    const silent = runWorker("const nothing = 1;");
    expect(silent.posted).toContainEqual({
      type: "error",
      message: "ambient() was not called",
    });
  });

  it("pauses and resumes the frame loop", () => {
    const worker = runWorker(
      "ambient((canvas) => ({ frame() { canvas.frames = (canvas.frames || 0) + 1; } }));",
    );
    const canvas = fakeCanvas() as ReturnType<typeof fakeCanvas> & {
      frames?: number;
    };
    worker.send({ type: "init", canvas, info: {} });
    worker.step(2);
    const beforePause = canvas.frames;
    expect(beforePause).toBeGreaterThan(0);
    worker.send({ type: "pause" });
    worker.step(3);
    expect(canvas.frames).toBe(beforePause);
  });
});
