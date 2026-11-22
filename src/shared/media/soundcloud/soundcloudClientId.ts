import { tryFetchText } from "@/shared/api/tryFetch";
import { rethrowIfAborted } from "@/shared/utils/abort";
import { fetchSoundCloud } from "./soundcloudTransport";

const SOUNDCLOUD_HOME = "https://soundcloud.com";
const SCRIPT_URL =
  /src="((?:https:)?\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
const CLIENT_ID_PATTERN = /client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/;

let cachedSoundCloudClientId: string | undefined;

export function rememberSoundCloudClientId(clientId: string): void {
  cachedSoundCloudClientId = clientId;
}

export function resetSoundCloudClientIdCache(): void {
  cachedSoundCloudClientId = undefined;
}

function scriptUrlsFromHtml(html: string): string[] {
  return [...html.matchAll(SCRIPT_URL)].map((match) =>
    match[1].startsWith("//") ? `https:${match[1]}` : match[1],
  );
}

/** the page answers no CORS headers, so the browser build reads it via the relay */
async function fetchHomePage(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchSoundCloud(SOUNDCLOUD_HOME, {
      headers: { accept: "text/html,application/xhtml+xml" },
      signal,
    });
    return response.ok ? await response.text() : undefined;
  } catch {
    rethrowIfAborted(signal);
    return undefined;
  }
}

/**
 * The client id lives in one of the page's asset chunks, but not a fixed one:
 * which chunk carries it moves between deploys. Fetching the newest few in
 * parallel turns the usual hit into one round trip, and the rest are only read
 * when that batch misses.
 */
async function clientIdFromScripts(
  urls: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const texts = await Promise.all(
    urls.map((url) =>
      tryFetchText(url, { signal }).catch(() => {
        rethrowIfAborted(signal);
        return undefined;
      }),
    ),
  );
  for (const text of texts) {
    const found = text?.match(CLIENT_ID_PATTERN)?.[1];
    if (found) return found;
  }
  return undefined;
}

async function discoverSoundCloudClientId(
  signal?: AbortSignal,
): Promise<string | undefined> {
  const html = await fetchHomePage(signal);
  const scripts = html ? scriptUrlsFromHtml(html).reverse() : [];
  const found =
    (await clientIdFromScripts(scripts.slice(0, 3), signal)) ??
    (await clientIdFromScripts(scripts.slice(3), signal));
  if (found) cachedSoundCloudClientId = found;
  return found;
}

export async function getSoundCloudClientId(
  configuredClientId?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (configuredClientId?.trim()) return configuredClientId.trim();
  if (cachedSoundCloudClientId) return cachedSoundCloudClientId;
  const discovered = await discoverSoundCloudClientId(signal);
  if (!discovered)
    throw new Error("SoundCloud is unavailable right now, try again later.");
  return discovered;
}

export async function refreshSoundCloudClientId(
  rejectedClientId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (cachedSoundCloudClientId === rejectedClientId)
    cachedSoundCloudClientId = undefined;
  const discovered = await discoverSoundCloudClientId(signal);
  return discovered && discovered !== rejectedClientId ? discovered : undefined;
}
