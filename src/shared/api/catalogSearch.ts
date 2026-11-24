import type { SearchResponse, SearchType } from "@/shared/contracts";
import { searchSoundCloudTracks } from "@/shared/media/soundcloud";
import { mergeSoundCloudTracks } from "@/shared/media/search";
import { isAbortError } from "@/shared/utils/abort";
import { log } from "@/shared/utils/logger";

const SOUNDCLOUD_SEARCH_TIMEOUT_MS = 2_500;

export interface SoundCloudSearchOptions {
  /** aborted when the query changes, so a stale lookup stops using the relay */
  signal?: AbortSignal;
  /**
   * The catalog's own answer, before the SoundCloud lookup lands. A search
   * paints as soon as the primary source settles instead of waiting for the
   * second catalog: the SoundCloud round trip used to hold the first result
   * back for up to 2.5 s, which is what typing in the search bar felt like.
   */
  onPrimary?: (items: SearchResponse["items"]) => void;
}

async function soundCloudTracksOrEmpty(query: string, signal?: AbortSignal) {
  if (signal?.aborted) return [];
  const timeout = AbortSignal.timeout(SOUNDCLOUD_SEARCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await searchSoundCloudTracks(query, combined);
  } catch (error) {
    if (signal?.aborted) return [];
    log("yellow", "catalog", "soundcloud search skipped", error);
    return [];
  }
}

function includesTracks(type: SearchType): boolean {
  return type === "track" || type === "all";
}

export async function withSoundCloudTracks(
  query: string,
  type: SearchType,
  primary: Promise<SearchResponse>,
  options: SoundCloudSearchOptions = {},
): Promise<SearchResponse> {
  if (!includesTracks(type)) return primary;
  const soundcloud = soundCloudTracksOrEmpty(query, options.signal);
  let items: SearchResponse["items"];
  try {
    items = (await primary).items;
  } catch (error) {
    if (isAbortError(error) || (await soundcloud).length === 0) throw error;
    return { items: mergeSoundCloudTracks(query, [], await soundcloud) };
  }
  options.onPrimary?.(items);
  return { items: mergeSoundCloudTracks(query, items, await soundcloud) };
}
