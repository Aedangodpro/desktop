import {
  getSoundCloudClientId,
  refreshSoundCloudClientId,
  rememberSoundCloudClientId,
} from "./soundcloudClientId";
import { apiRelayUrl } from "@/web/proxyUrls";

export const SOUNDCLOUD_API = "https://api-v2.soundcloud.com";

export interface SoundCloudRequestOptions {
  signal?: AbortSignal;
}

function isClientIdRejection(status: number): boolean {
  return status === 401 || status === 403;
}

function buildUrl(
  pathOrUrl: string,
  params: Record<string, string>,
  clientId: string,
): string {
  const url = new URL(pathOrUrl, SOUNDCLOUD_API);
  for (const [name, value] of Object.entries(params))
    url.searchParams.set(name, value);
  url.searchParams.set("client_id", clientId);
  return url.toString();
}

export async function fetchSoundCloudApi(
  pathOrUrl: string,
  params: Record<string, string> = {},
  options: SoundCloudRequestOptions = {},
): Promise<Response> {
  const { signal } = options;
  let clientId = await getSoundCloudClientId(undefined, signal);
  // the API sends no CORS headers, so in a browser it is read through the
  // site's own relay (a no-op on the desktop, where Electron adds them)
  let response = await fetch(apiRelayUrl(buildUrl(pathOrUrl, params, clientId)), {
    signal,
  });
  if (isClientIdRejection(response.status)) {
    const refreshed = await refreshSoundCloudClientId(clientId, signal);
    if (refreshed) {
      clientId = refreshed;
      response = await fetch(
        apiRelayUrl(buildUrl(pathOrUrl, params, clientId)),
        { signal },
      );
    }
  }
  if (response.ok) rememberSoundCloudClientId(clientId);
  return response;
}
