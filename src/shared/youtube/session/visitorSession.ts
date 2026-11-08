import { asRecord } from "@/shared/utils/json";
import { parseVisitorData } from "./visitorData";
import { innertubeProxyUrl } from "@/web/proxyUrls";

/**
 * Client-side YouTube visitorData session manager.
 *
 * visitorData is what keeps anonymous player calls out of YouTube's "confirm
 * you're not a bot" check, which would otherwise surface as a sign-in demand.
 * It comes from the same document the YouTube web player reads (`sw.js_data`);
 * when that document omits it, the visitor endpoint mints one directly. Both
 * requests go through the web relay so a browser can make them at all.
 */

interface VisitorSession {
  visitorData: string;
  expiresAt: number;
}

let cachedSession: VisitorSession | null = null;
let pendingFetch: Promise<string> | null = null;
let failedAt = 0;

const FETCH_TIMEOUT_MS = 8_000;
const FAILURE_COOLDOWN_MS = 60_000;

const SESSION_TTL_MS = 5.5 * 60 * 60 * 1000; // 5.5 hours

const VISITOR_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20250101.00.00",
};

function browserUserAgent(): string {
  return typeof navigator !== "undefined"
    ? navigator.userAgent
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
}

export function resetClientVisitorData(): void {
  cachedSession = null;
  failedAt = 0;
}

async function fetchFromSwData(): Promise<string> {
  const res = await fetch(
    innertubeProxyUrl("https://www.youtube.com/sw.js_data"),
    {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": browserUserAgent() },
    },
  );

  if (!res.ok) {
    throw new Error(`sw.js_data returned ${res.status}`);
  }

  const visitorData = parseVisitorData(await res.text());
  if (!visitorData) {
    throw new Error("Could not parse visitorData from sw.js_data");
  }

  return visitorData;
}

/**
 * sw.js_data usually carries the visitor blob, but it may answer without one
 * (a stripped or cached document). The endpoint returns it as JSON, which is
 * enough to keep playback out of the bot check instead of failing the track.
 */
async function fetchFromVisitorEndpoint(): Promise<string> {
  const res = await fetch(
    innertubeProxyUrl(
      "https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false",
    ),
    {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-youtube-client-name": "1",
        "x-youtube-client-version": VISITOR_CLIENT.clientVersion,
        "user-agent": browserUserAgent(),
      },
      body: JSON.stringify({
        context: {
          client: { ...VISITOR_CLIENT, hl: "en", gl: "US" },
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`visitor_id returned ${res.status}`);
  }

  const body = asRecord((await res.json().catch(() => null)) as unknown);
  const raw = asRecord(body?.responseContext)?.visitorData;
  if (typeof raw !== "string") {
    throw new Error("visitor_id returned no visitorData");
  }

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // already decoded
  }

  const visitorData = parseVisitorData(decoded);
  if (!visitorData) {
    throw new Error("visitor_id returned invalid visitorData");
  }

  return visitorData;
}

export async function getClientVisitorData(): Promise<string> {
  const now = Date.now();
  if (cachedSession && cachedSession.expiresAt > now) {
    return cachedSession.visitorData;
  }

  if (pendingFetch) {
    return pendingFetch;
  }

  if (now - failedAt < FAILURE_COOLDOWN_MS) {
    return cachedSession?.visitorData ?? "";
  }

  pendingFetch = (async () => {
    try {
      let visitorData = "";
      try {
        visitorData = await fetchFromSwData();
      } catch (error) {
        console.warn("[VisitorSession] sw.js_data failed:", error);
      }
      if (!visitorData) {
        visitorData = await fetchFromVisitorEndpoint();
      }

      failedAt = 0;
      cachedSession = {
        visitorData,
        expiresAt: Date.now() + SESSION_TTL_MS,
      };

      console.info(
        `%c[VisitorSession]%c Ready: ${visitorData.slice(0, 16)}... (valid 5.5h)`,
        "color: #10b981; font-weight: bold;",
        "color: inherit;",
      );

      return visitorData;
    } catch (err) {
      failedAt = Date.now();
      console.warn("[VisitorSession] Failed to fetch fresh visitorData:", err);
      // Fallback: if cached exists even if slightly expired, keep it
      if (cachedSession?.visitorData) {
        return cachedSession.visitorData;
      }
      return "";
    } finally {
      pendingFetch = null;
    }
  })();

  return pendingFetch;
}

/**
 * Eagerly warm up the client's visitorData on app launch in the background.
 */
export function initClientVisitorSession(): void {
  void getClientVisitorData().catch(() => {});
}
