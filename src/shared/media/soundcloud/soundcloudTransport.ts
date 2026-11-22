import { IS_WEB_TARGET } from "@/shared/config/runtimeTarget";
import { log } from "@/shared/utils/logger";
import { apiRelayUrl, mediaProxyUrl } from "@/web/proxyUrls";

/**
 * How a browser reaches SoundCloud's API.
 *
 * `api-v2.soundcloud.com` sends no CORS headers, so a page can only read it
 * through this app's own relay. `/__yt` is the direct route — one request, no
 * probing. A deployment whose worker predates the SoundCloud allowlist answers
 * it with a proxy refusal, and the media relay (`/__media`) pipes any host on
 * the desktop CORS allowlist, SoundCloud included. So one refusal switches to
 * that route for the rest of the session instead of failing every lookup on the
 * page for good.
 *
 * A refused lookup used to be indistinguishable from "this song is not on
 * SoundCloud", because every caller swallowed the error: the fallback that
 * exists for exactly this case did nothing and said nothing.
 */

type Route = "innertube" | "media";

let route: Route = "innertube";

/** the relay's own refusal, as opposed to an answer from SoundCloud */
async function isRelayRefusal(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 404) return false;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) return true;
  const body = await response.clone().text().catch(() => "");
  return body.includes("_PROXY_") && body.includes("REFUSED");
}

async function fetchViaMediaRelay(
  url: string,
  init: RequestInit,
): Promise<Response> {
  route = "media";
  return fetch(mediaProxyUrl(url), init);
}

export async function fetchSoundCloud(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!IS_WEB_TARGET) return fetch(url, init);
  if (route === "media") return fetchViaMediaRelay(url, init);
  let response: Response;
  try {
    response = await fetch(apiRelayUrl(url), init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    log(
      "yellow",
      "playback",
      `soundcloud: /__yt unreachable (${String(error)}), using the media relay`,
    );
    return fetchViaMediaRelay(url, init);
  }
  if (!(await isRelayRefusal(response))) return response;
  log(
    "yellow",
    "playback",
    "soundcloud: /__yt does not forward soundcloud here, using the media relay",
  );
  return fetchViaMediaRelay(url, init);
}
