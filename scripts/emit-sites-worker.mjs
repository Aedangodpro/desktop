#!/usr/bin/env node
/**
 * Emits the Freebuff Sites worker.
 *
 * - `worker/signer.wasm` is decoded from the tracked `electron/signer.ts`, so
 *   signatures stay identical to the desktop build.
 * - `worker/index.mjs` is the template that imports that wasm as a module.
 *
 * The wasm must be a module, not bytes: workerd compiles modules at deploy time
 * and rejects `WebAssembly.instantiate(bytes)` at runtime.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const signerPath = path.join(root, "electron", "signer.ts");
const templatePath = path.join(root, "worker", "index.template.mjs");
const outPath = path.join(root, "worker", "index.mjs");
const wasmPath = path.join(root, "worker", "signer.wasm");

const signerSource = fs.readFileSync(signerPath, "utf8");
const match = /SIGNER_WASM_BASE64\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(signerSource);
if (!match) {
  throw new Error(`No SIGNER_WASM_BASE64 found in ${signerPath}`);
}

const wasm = Buffer.from(match[1], "base64");
if (wasm.subarray(0, 4).toString("hex") !== "0061736d") {
  throw new Error("Decoded signer is not a wasm binary");
}
fs.writeFileSync(wasmPath, wasm);

const template = fs.readFileSync(templatePath, "utf8");
if (!template.includes('from "./signer.wasm"')) {
  throw new Error("Worker template does not import the signer wasm");
}
fs.writeFileSync(outPath, template);

console.log(
  `worker/index.mjs + worker/signer.wasm written (${Math.round(wasm.length / 1024)} KiB wasm)`,
);
