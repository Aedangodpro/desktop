#!/usr/bin/env node
/**
 * Smoke-tests the Sites worker the way it actually runs: under workerd, with
 * the built assets and the deploy-time signer wasm.
 *
 * The worker cannot be imported into plain Node (`.wasm` is a module), so this
 * starts `wrangler dev`, exercises the routes over HTTP and shuts it down.
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const PORT = Number(process.env.SITES_TEST_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const config = "wrangler.sites.jsonc";

const server = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--yes", "wrangler@4", "dev", "--config", config, "--ip", "127.0.0.1", "--port", String(PORT)],
  { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", env: { ...process.env, CI: "1" } },
);

let output = "";
server.stdout.on("data", (chunk) => (output += chunk));
server.stderr.on("data", (chunk) => (output += chunk));

function stop() {
  try {
    if (process.platform === "win32") server.kill();
    else process.kill(-server.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function waitForReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${BASE}/`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`wrangler dev never became ready:\n${output.slice(-800)}`);
}

async function run() {
  await waitForReady();

  const root = await fetch(`${BASE}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type") ?? "", /text\/html/);
  const html = await root.text();
  assert.match(html, /src="\/assets\/index\.web-[^"]+\.js"/);
  console.log("root + hashed asset entry: ok");

  const assetPath = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(assetPath, "asset path missing");
  const asset = await fetch(`${BASE}${assetPath}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  console.log("built asset served: ok");

  const spa = await fetch(`${BASE}/search?q=test`, {
    headers: { accept: "text/html" },
  });
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await spa.text(), /id="root"/);
  console.log("SPA route falls back to index.html: ok");

  const missing = await fetch(`${BASE}/does-not-exist.js`);
  assert.equal(missing.status, 404);
  console.log("unknown asset 404: ok");

  const foreignMedia = await fetch(
    `${BASE}/__media?url=${encodeURIComponent("https://evil.test/a.mp3")}`,
  );
  assert.equal(foreignMedia.status, 403);
  const foreignYt = await fetch(`${BASE}/__yt/evil.test/youtubei/v1/player`);
  assert.equal(foreignYt.status, 403);
  console.log("relay host allowlists: ok");

  // A signed call must reach the API (any answer but 500 proves the wasm ran).
  const signed = await fetch(`${BASE}/__liner/v1/me`);
  assert.notEqual(signed.status, 500, await signed.clone().text());
  assert.ok([200, 401, 403].includes(signed.status), `unexpected ${signed.status}`);
  console.log(`signed API call reached upstream: ${signed.status}`);

  const yt = await fetch(`${BASE}/__yt/music.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00" } },
      videoId: "dQw4w9WgXcQ",
    }),
  });
  assert.ok(yt.status < 500, `innertube relay returned ${yt.status}`);
  console.log(`innertube relay answered: ${yt.status}`);
}

run()
  .then(() => {
    stop();
    console.log("sites worker checks passed");
  })
  .catch((error) => {
    stop();
    console.error(error);
    process.exit(1);
  });
