import { InnertubeError } from "./innertubeClient";
import { mediaProxyUrl } from "@/web/proxyUrls";

const PROBE_OFFSET = 1_048_576 + 4096;
const REJECTED_PREFIX = "stream url rejected with";

/** googlevideo answered 403 to a stream url it handed out: the network is refused, not the track */
export function isStreamRefused(error: unknown): boolean {
  return (
    error instanceof InnertubeError &&
    error.status === 403 &&
    error.message.startsWith(REJECTED_PREFIX)
  );
}

export async function assertStreamReachable(
  url: string,
  contentLength: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const offset =
    contentLength && contentLength > PROBE_OFFSET ? PROBE_OFFSET : 0;
  // A `range` query param is not a Range request: googlevideo answers a plain
  // GET with `403`, and on web the param would land on the relay url instead of
  // the media url. The header is what both hosts actually honour.
  const response = await fetch(mediaProxyUrl(url), {
    signal,
    headers: { range: `bytes=${offset}-${offset}` },
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok)
    throw new InnertubeError(
      `${REJECTED_PREFIX} ${response.status}`,
      response.status,
    );
}
