/**
 * Ambient effects render at 30 fps at most. They are slow-moving background
 * washes, and every extra frame is a full-surface draw plus a compositor pass
 * on top of the player's WebGL background.
 */
const MAX_AMBIENT_FPS = 30;

const RUNTIME = `
let effect = null;
let canvas = null;
let info = null;
let state = { positionMs: 0, playing: false, energy: 0 };
let running = false;
let last = 0;
let elapsed = 0;
let maskSpec = null;
let maskSurface = null;
let surfaceCtx = null;

const fail = (error) => {
  running = false;
  self.postMessage({ type: "error", message: String(error && error.message ? error.message : error) });
};

/**
 * The fade and cover hole used to be a CSS mask on the host. On a canvas that
 * changes every frame that mask is a full compositor pass per frame, so the
 * same shape is baked once here and multiplied in with one drawImage.
 */
const buildMask = () => {
  maskSurface = null;
  const spec = maskSpec;
  if (!spec || !canvas || !canvas.width || !canvas.height) return;
  if (typeof OffscreenCanvas === "undefined") return;
  const width = canvas.width;
  const height = canvas.height;
  const surface = new OffscreenCanvas(width, height);
  const ctx = surface.getContext("2d");
  if (!ctx) return;
  const fade = ctx.createLinearGradient(0, 0, width, 0);
  fade.addColorStop(spec.fadeStart, "rgba(0, 0, 0, 1)");
  fade.addColorStop(spec.fadeEnd, "rgba(0, 0, 0, " + spec.fadeEndAlpha + ")");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, width, height);
  if (spec.hole) {
    const x = spec.hole.x * width;
    const y = spec.hole.y * height;
    const inner = spec.hole.inner * width;
    const outer = Math.max(spec.hole.outer * width, inner + 0.5);
    const hole = ctx.createRadialGradient(x, y, inner, x, y, outer);
    hole.addColorStop(0, "rgba(0, 0, 0, 1)");
    hole.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = hole;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
  }
  maskSurface = surface;
};

const applyMask = () => {
  if (!maskSurface || !surfaceCtx) return;
  const ctx = surfaceCtx;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(maskSurface, 0, 0);
  ctx.restore();
};

let pending = 0;

const tick = (now) => {
  if (!running) return;
  pending += last ? (now - last) / 1000 : 0;
  last = now;
  const fps = Math.min(${MAX_AMBIENT_FPS}, Math.max(1, Number(effect.fps) || 60));
  if (pending > 0 && pending < 1 / fps - 0.004) {
    self.requestAnimationFrame(tick);
    return;
  }
  const dt = Math.min(pending, 0.1);
  pending = 0;
  elapsed += dt;
  try {
    effect.frame({ ...state, time: elapsed, dt });
    applyMask();
  } catch (error) {
    fail(error);
    return;
  }
  self.requestAnimationFrame(tick);
};

const start = () => {
  if (running || !effect) return;
  running = true;
  last = 0;
  pending = 0;
  self.requestAnimationFrame(tick);
};

self.ambient = (setup) => {
  self.ambientSetup = setup;
};

self.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      canvas = message.canvas;
      surfaceCtx = canvas ? canvas.getContext("2d") : null;
      info = message.info;
      effect = self.ambientSetup(canvas, info) || {};
      effect.frame = effect.frame || (() => {});
      self.postMessage({ type: "options", pixelated: Boolean(effect.pixelated), scale: Number(effect.scale) || 0, blur: typeof effect.blur === "number" ? effect.blur : undefined });
      if (message.mask) { maskSpec = message.mask; buildMask(); }
      start();
    } else if (message.type === "resize" && canvas) {
      canvas.width = message.width;
      canvas.height = message.height;
      if (effect && effect.resize) effect.resize(message.width, message.height);
      buildMask();
    } else if (message.type === "mask") {
      maskSpec = message.mask || null;
      buildMask();
    } else if (message.type === "state") {
      state = { ...state, ...message.state };
    } else if (message.type === "pause") {
      running = false;
    } else if (message.type === "resume") {
      start();
    }
  } catch (error) {
    fail(error);
  }
};
`;

export function buildAmbientWorkerSource(script: string): string {
  return `${RUNTIME}\n;${script}\n;if (typeof self.ambientSetup !== "function") { self.postMessage({ type: "error", message: "ambient() was not called" }); }`;
}
