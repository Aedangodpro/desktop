// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { signWithSecret } from "../../../electron/crypto";
import {
  createApiProxy,
  rewriteSetCookie,
  type ApiProxySigner,
} from "./apiProxy";

const SECRET = "test-signing-secret";

const testSigner: ApiProxySigner = ({ method, path, body }) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Math.random().toString(16).slice(2, 18);
  return {
    signature: signWithSecret(SECRET, method, path, body ?? "", timestamp, nonce),
    timestamp,
    nonce,
  };
};

type Seen = {
  method: string;
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
  signatureValid: boolean;
};

const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Mock upstream that verifies the HMAC the proxy claims to send. */
async function startUpstream(
  reply: (seen: Seen) => { status: number; headers?: Record<string, string>; body: string },
): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "/").split("?")[0];
      const signature = String(req.headers["x-liner-signature"] ?? "");
      const timestamp = Number(req.headers["x-liner-timestamp"] ?? 0);
      const nonce = String(req.headers["x-liner-nonce"] ?? "");
      const expected = signWithSecret(
        SECRET,
        (req.method ?? "GET").toUpperCase(),
        path,
        body,
        timestamp,
        nonce,
      );
      const record: Seen = {
        method: req.method ?? "GET",
        path,
        body,
        headers: req.headers,
        signatureValid: signature === expected,
      };
      seen.push(record);
      const out = reply(record);
      res.writeHead(out.status, out.headers ?? { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, seen };
}

async function startProxy(
  target: string,
  sign: ApiProxySigner = testSigner,
): Promise<string> {
  const handle = createApiProxy({ target, sign });
  const server = http.createServer((req, res) => {
    void handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("not proxied");
      }
    });
  });
  const port = await listen(server);
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("api proxy", () => {
  it("signs GET requests so the upstream can verify them", async () => {
    const upstream = await startUpstream((seen) => ({
      status: 200,
      body: JSON.stringify({ path: seen.path, valid: seen.signatureValid }),
    }));
    const proxy = await startProxy(upstream.origin);

    const res = await fetch(`${proxy}/__liner/v1/me?limit=5`);
    const body = (await res.json()) as { path: string; valid: boolean };

    expect(res.status).toBe(200);
    expect(body.path).toBe("/v1/me");
    expect(body.valid).toBe(true);
    expect(upstream.seen[0]?.signatureValid).toBe(true);
  });

  it("signs the exact POST body and forwards it unchanged", async () => {
    const upstream = await startUpstream((seen) => ({
      status: 200,
      body: JSON.stringify({
        received: seen.body,
        contentType: seen.headers["content-type"],
        valid: seen.signatureValid,
      }),
    }));
    const proxy = await startProxy(upstream.origin);
    const payload = JSON.stringify({ email: "a@b.co", password: "hunter2" });

    const res = await fetch(`${proxy}/__liner/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const body = (await res.json()) as { received: string; valid: boolean };

    expect(body.valid).toBe(true);
    expect(body.received).toBe(payload);
  });

  it("replaces a browser-supplied signature instead of trusting it", async () => {
    const upstream = await startUpstream((seen) => ({
      status: 200,
      body: JSON.stringify({ valid: seen.signatureValid }),
    }));
    const proxy = await startProxy(upstream.origin);

    await fetch(`${proxy}/__liner/v1/me`, {
      headers: { "x-liner-signature": "forged", "x-liner-nonce": "forged" },
    });

    expect(upstream.seen[0]?.signatureValid).toBe(true);
    expect(upstream.seen[0]?.headers["x-liner-signature"]).not.toBe("forged");
  });

  it("keeps the bearer token but drops the browser origin", async () => {
    const upstream = await startUpstream((seen) => ({
      status: 200,
      body: JSON.stringify({
        authorization: seen.headers["authorization"] ?? null,
        origin: seen.headers["origin"] ?? null,
      }),
    }));
    const proxy = await startProxy(upstream.origin);

    const res = await fetch(`${proxy}/__liner/v1/me`, {
      headers: { authorization: "Bearer token-123", origin: "http://localhost:3000" },
    });
    const body = (await res.json()) as {
      authorization: string | null;
      origin: string | null;
    };

    expect(body.authorization).toBe("Bearer token-123");
    expect(body.origin).toBeNull();
  });

  it("passes the api's bare 403 through instead of inventing a gateway error", async () => {
    const upstream = await startUpstream(() => ({
      status: 403,
      headers: { "content-type": "text/plain" },
      body: "Forbidden",
    }));
    const proxy = await startProxy(upstream.origin);

    const res = await fetch(`${proxy}/__liner/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  it("passes a real application 403 through untouched", async () => {
    const upstream = await startUpstream(() => ({
      status: 403,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "INVALID_CREDENTIALS" }),
    }));
    const proxy = await startProxy(upstream.origin);

    const res = await fetch(`${proxy}/__liner/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "INVALID_CREDENTIALS",
    );
  });

  it("rewrites cookie scope so the browser sends it back on /__liner", async () => {
    const upstream = await startUpstream(() => ({
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=abc; Domain=api.example.com; Path=/v1/auth; HttpOnly",
      },
      body: "{}",
    }));
    const proxy = await startProxy(upstream.origin);

    const res = await fetch(`${proxy}/__liner/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const cookie = res.headers.get("set-cookie") ?? "";

    expect(cookie).not.toMatch(/domain=/i);
    expect(cookie).toMatch(/path=\//i);
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const proxy = await startProxy("http://127.0.0.1:1");
    const res = await fetch(`${proxy}/__liner/v1/me`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      "API_PROXY_UNREACHABLE",
    );
  });

  it("leaves non-proxy paths alone", async () => {
    const handle = createApiProxy({ target: "http://127.0.0.1:1", sign: testSigner });
    const server = http.createServer((req, res) => {
      void handle(req, res).then((handled) => {
        res.writeHead(handled ? 200 : 418);
        res.end("done");
      });
    });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(res.status).toBe(418);
  });
});

describe("cookie helpers", () => {
  it("adds a root path when the cookie has none", () => {
    expect(rewriteSetCookie("a=b; HttpOnly")).toBe("a=b; HttpOnly; Path=/");
  });
});
