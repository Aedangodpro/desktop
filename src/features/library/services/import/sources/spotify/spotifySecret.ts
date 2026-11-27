import { asRecord } from "@/shared/utils/json";
import { tryFetchJson, tryFetchText } from "@/shared/api/tryFetch";
import { mediaProxyUrl } from "@/web/proxyUrls";

export interface SpotifyTotpSecret {
  secret: string;
  version: number;
}

const WEB_PLAYER_SCRIPT =
  /src="(https:\/\/open\.spotifycdn\.com\/cdn\/build\/(?:mobile-)?web-player\/(?:mobile-)?web-player\.[a-f0-9]+\.js)"/;
const SECRET_ENTRY = /\{secret:(['"])((?:\\.|(?!\1)[^\\])*)\1,version:(\d+)\}/g;

export function extractSpotifySecret(
  js: string,
): SpotifyTotpSecret | undefined {
  let newest: SpotifyTotpSecret | undefined;
  for (const match of js.matchAll(SECRET_ENTRY)) {
    const candidate = {
      secret: match[2].replace(/\\(.)/g, "$1"),
      version: Number(match[3]),
    };
    if (!newest || candidate.version > newest.version) newest = candidate;
  }
  return newest;
}

export async function fetchSpotifySecret(
  signal?: AbortSignal,
): Promise<SpotifyTotpSecret> {
  const html = await tryFetchText(
    mediaProxyUrl("https://open.spotify.com/", true),
    {
      signal,
    },
  );
  const scriptUrl = html?.match(WEB_PLAYER_SCRIPT)?.[1];
  const js = scriptUrl
    ? await tryFetchText(mediaProxyUrl(scriptUrl, true), { signal })
    : undefined;
  const secret = js ? extractSpotifySecret(js) : undefined;
  if (!secret)
    throw new Error("Spotify is unavailable right now, try again later.");
  return secret;
}

export async function fetchSpotifyServerTime(
  signal?: AbortSignal,
): Promise<number | null> {
  const data = asRecord(
    await tryFetchJson(
      mediaProxyUrl("https://open.spotify.com/api/server-time", true),
      { signal },
    ),
  );
  const serverTime = Number(data?.serverTime);
  return data && !Number.isNaN(serverTime) ? serverTime : null;
}
