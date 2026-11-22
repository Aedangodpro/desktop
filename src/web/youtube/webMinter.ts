/**
 * Browser port of the desktop PO token minter.
 *
 * YouTube bot-checks the address a request comes from. A shared host — this
 * app's own Worker — gets flagged routinely, and then every playability call
 * answers LOGIN_REQUIRED no matter which Innertube client asks. A PO token
 * proves a real browser computed the challenge, which is what the desktop
 * mints through the main process; here BotGuard runs in the page and its two
 * network calls go through the site's own relay.
 */

import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { buildURL, GOOG_API_KEY } from "bgutils-js/utils";
import { innertubeProxyUrl } from "@/web/proxyUrls";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const WEB_CLIENT_VERSION = "2.20250925.01.00";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

interface Challenge {
  program: string;
  globalName: string;
  interpreterUrl?: string;
  interpreterScript?: string;
}

interface RawChallenge {
  interpreterUrl?: {
    privateDoNotAccessOrElseTrustedResourceUrlWrappedValue?: string;
  };
  interpreterJavascript?: {
    privateDoNotAccessOrElseSafeScriptWrappedValue?: string;
  };
  program?: string;
  globalName?: string;
}

function readChallenge(raw: RawChallenge | undefined): Challenge {
  const interpreterUrl =
    raw?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  const interpreterScript =
    raw?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (
    !raw?.program ||
    !raw.globalName ||
    !(interpreterUrl || interpreterScript)
  )
    throw new Error("BotGuard challenge is missing");
  return {
    program: raw.program,
    globalName: raw.globalName,
    ...(interpreterUrl ? { interpreterUrl } : {}),
    ...(interpreterScript ? { interpreterScript } : {}),
  };
}

async function fetchChallenge(): Promise<Challenge> {
  const response = await fetch(
    innertubeProxyUrl(
      "https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false",
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: WEB_CLIENT_VERSION,
            hl: "en",
            gl: "US",
          },
        },
        engagementType: "ENGAGEMENT_TYPE_UNBOUND",
      }),
    },
  );
  if (!response.ok) throw new Error(`att/get returned ${response.status}`);
  const body = (await response.json()) as { bgChallenge?: RawChallenge };
  return readChallenge(body.bgChallenge);
}

async function loadInterpreter(challenge: Challenge): Promise<string> {
  if (challenge.interpreterScript) return challenge.interpreterScript;
  const url = challenge.interpreterUrl ?? "";
  const absolute = url.startsWith("//") ? `https:${url}` : url;
  const response = await fetch(innertubeProxyUrl(absolute));
  if (!response.ok)
    throw new Error(`BotGuard interpreter returned ${response.status}`);
  return response.text();
}

async function generateIntegrityToken(botguardResponse: string) {
  const response = await fetch(innertubeProxyUrl(buildURL("GenerateIT", true)), {
    method: "POST",
    headers: {
      "content-type": "application/json+protobuf",
      "x-goog-api-key": GOOG_API_KEY,
      "x-user-agent": "grpc-web-javascript/0.1",
    },
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!response.ok) throw new Error(`GenerateIT returned ${response.status}`);
  const [token, ttlSeconds] = (await response.json()) as [
    string | null,
    number?,
  ];
  if (!token) throw new Error("GenerateIT returned no integrity token");
  return { token, ...(ttlSeconds ? { ttlSeconds } : {}) };
}

interface MinterEntry {
  minter: WebPoMinter;
  expiresAt: number;
}

let cached: MinterEntry | null = null;
let pending: Promise<MinterEntry> | null = null;

async function createMinter(): Promise<MinterEntry> {
  const challenge = await fetchChallenge();
  new Function(await loadInterpreter(challenge))();
  const botguard = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis,
  });
  const webPoSignalOutput: Parameters<typeof WebPoMinter.create>[1] = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
  const { token, ttlSeconds } = await generateIntegrityToken(botguardResponse);
  const minter = await WebPoMinter.create(
    { integrityToken: token.replace(/\+/g, "-").replace(/\//g, "_") },
    webPoSignalOutput,
  );
  const ttlMs =
    (ttlSeconds && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS) * 1000;
  return {
    minter,
    expiresAt: Date.now() + Math.max(ttlMs - REFRESH_MARGIN_MS, 60_000),
  };
}

function currentMinter(): Promise<MinterEntry> {
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached);
  pending ??= createMinter()
    .then((entry) => {
      cached = entry;
      return entry;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function resetWebMinter(): void {
  cached = null;
}

export async function mintWebPoToken(identifier: string): Promise<string> {
  try {
    const { minter } = await currentMinter();
    return await minter.mintAsWebsafeString(identifier);
  } catch (error) {
    resetWebMinter();
    throw error;
  }
}
