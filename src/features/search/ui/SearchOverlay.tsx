import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useNavigate } from "react-router-dom";
import {
  collectionPath,
  collectionPreviewState,
} from "@/features/collection/lib/collectionPreview";
import { AnimatePresence, motion } from "framer-motion";
import {
  Search3Line,
  CloseCircleFill,
  GridFill,
  Music2Fill,
  User2Fill,
  AlbumFill,
  PlaylistFill,
} from "@mingcute/react";
import { mediaUrl, toClientTrack, toMaxQualityAvatarUrl } from "@/shared/api";
import { playerEngine } from "@/features/player";
import { useModalStore } from "@/features/library";
import { useTranslation } from "@/languages";
import { useSearchHistoryStore } from "../store/searchHistoryStore";
import { SearchHistoryList } from "./SearchHistoryList";
import SearchResultsList from "./SearchResultsList";
import {
  useSearchAll,
  useSearchAlbums,
  useSearchArtists,
  useSearchPlaylists,
  useSearchTracks,
} from "../hooks";

const SEARCH_QUERY_CACHE_TTL_MS = 60_000;
/**
 * How long the typed text waits before it becomes React state. The input itself
 * is uncontrolled, so every keystroke costs nothing but the browser's own caret
 * update; this is the only thing that re-renders the results.
 */
const SEARCH_TYPE_COMMIT_MS = 160;
const SIDEBAR_WIDTH = 58;
const SHELL_EDGE_GAP = 6;

type SearchFilterKey = "all" | "tracks" | "artists" | "albums" | "playlists";

/**
 * The search popup, and the query that drives it.
 *
 * The query lives here rather than in `AppFrame` on purpose: the frame is the
 * whole window (header, sidebar, the open page, the player bar), so keeping the
 * query there meant every keystroke re-rendered all of it and re-committed the
 * subtree under the text cursor. Typing now re-renders this component alone.
 */
export function SearchOverlay({
  open,
  popupRef,
}: {
  open: boolean;
  popupRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const closeSearch = useModalStore((state) => state.closeSearch);

  const [searchQuery, setSearchQuery] = useState("");
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // the input is uncontrolled on purpose: a controlled input has to commit a
  // render per keystroke to move the caret, and that render is this whole
  // popup's results tree. Debounce the state instead.
  const commitTypedQuery = (value: string, immediate = false) => {
    if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
    if (immediate) {
      setSearchQuery(value);
      return;
    }
    typeTimerRef.current = setTimeout(
      () => setSearchQuery(value),
      SEARCH_TYPE_COMMIT_MS,
    );
  };

  useEffect(() => {
    return () => {
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
    };
  }, []);
  const [activeFilter, setActiveFilter] = useState<SearchFilterKey>("all");
  const [searchScrollMask, setSearchScrollMask] = useState(
    "linear-gradient(to bottom, black 0%, black 100%)",
  );

  const addHistoryItem = useSearchHistoryStore((state) => state.addItem);
  const historyItems = useSearchHistoryStore((state) => state.items);

  const isAllSearchFilter = activeFilter === "all";
  const isTrackSearchFilter = activeFilter === "tracks";
  const isArtistSearchFilter = activeFilter === "artists";
  const isAlbumSearchFilter = activeFilter === "albums";
  const isPlaylistSearchFilter = activeFilter === "playlists";
  const hasSearchQuery = searchQuery.trim().length > 0;

  const filterKeys: SearchFilterKey[] = [
    "all",
    "tracks",
    "artists",
    "albums",
    "playlists",
  ];
  const filterLabels: Record<SearchFilterKey, string> = {
    all: t("common.all"),
    tracks: t("common.songs"),
    artists: t("common.artists"),
    albums: t("common.albums"),
    playlists: t("common.playlists"),
  };

  const {
    items: allResults,
    loading: allLoading,
    hasLoaded: allHasLoaded,
    runNow: runAllSearchNow,
    partialWarning,
  } = useSearchAll(searchQuery, {
    enabled: open && isAllSearchFilter,
    limit: 20,
    debounceMs: 320,
  });

  const {
    tracks: trackResults,
    loading: trackLoading,
    hasLoaded: trackHasLoaded,
    runNow: runTrackSearchNow,
  } = useSearchTracks(searchQuery, {
    enabled: open && isTrackSearchFilter,
    limit: 20,
    debounceMs: 320,
  });

  const {
    artists: artistResults,
    loading: artistLoading,
    hasLoaded: artistHasLoaded,
    runNow: runArtistSearchNow,
  } = useSearchArtists(searchQuery, {
    enabled: open && isArtistSearchFilter,
    limit: 20,
    debounceMs: 320,
  });

  const {
    albums: albumResults,
    loading: albumLoading,
    hasLoaded: albumHasLoaded,
    runNow: runAlbumSearchNow,
  } = useSearchAlbums(searchQuery, {
    enabled: open && isAlbumSearchFilter,
    limit: 20,
    debounceMs: 320,
  });

  const {
    playlists: playlistResults,
    loading: playlistLoading,
    hasLoaded: playlistHasLoaded,
    runNow: runPlaylistSearchNow,
  } = useSearchPlaylists(searchQuery, {
    enabled: open && isPlaylistSearchFilter,
    limit: 20,
    debounceMs: 320,
  });

  const searchResults = useMemo(() => {
    if (isAllSearchFilter) {
      return allResults.map((item: any) => {
        const coverUrl = item.cover
          ? mediaUrl(item.cover.url)
          : (item.coverUrl ?? "");
        if (item.type === "track") {
          const clientTrack = toClientTrack(item);
          return {
            ...clientTrack,
            ...item,
            _type: "track",
            coverUrl: clientTrack.coverUrl || coverUrl,
            artists: clientTrack.artists,
            artistId: clientTrack.artistId,
            artistList: clientTrack.artistList,
          };
        }
        if (item.type === "artist") {
          return {
            ...item,
            _type: "artist",
            title: item.name,
            coverUrl: toMaxQualityAvatarUrl(coverUrl),
            artists: "",
          };
        }
        if (item.type === "album") {
          return {
            ...item,
            _type: "album",
            coverUrl,
            artists: Array.isArray(item.artists)
              ? item.artists.map((a: any) => a.name).join(", ")
              : (item.artists ?? ""),
            artistId: item.artists?.[0]?.id,
            artistList: Array.isArray(item.artists)
              ? item.artists.map((a: any) => ({ id: a.id, name: a.name }))
              : undefined,
          };
        }
        return {
          ...item,
          _type: item.type,
          coverUrl,
          artists: item.author ?? item.artists ?? "",
          artistId: item.artists?.[0]?.id,
          artistList: Array.isArray(item.artists)
            ? item.artists.map((a: any) => ({ id: a.id, name: a.name }))
            : undefined,
        };
      });
    }
    if (isTrackSearchFilter)
      return trackResults.map((track: any) => {
        const clientTrack = toClientTrack(track);
        return {
          ...clientTrack,
          ...track,
          _type: "track",
          coverUrl:
            clientTrack.coverUrl ||
            (track.cover ? mediaUrl(track.cover.url) : (track.coverUrl ?? "")),
          artists: clientTrack.artists,
          artistId: clientTrack.artistId,
          artistList: clientTrack.artistList,
        };
      });
    if (isArtistSearchFilter)
      return artistResults.map((artist: any) => ({
        ...artist,
        _type: "artist",
        title: artist.name,
        coverUrl: toMaxQualityAvatarUrl(
          artist.cover ? mediaUrl(artist.cover.url) : (artist.coverUrl ?? ""),
        ),
      }));
    if (isAlbumSearchFilter)
      return albumResults.map((album: any) => ({
        ...album,
        _type: "album",
        coverUrl: album.cover
          ? mediaUrl(album.cover.url)
          : (album.coverUrl ?? ""),
        artists: Array.isArray(album.artists)
          ? album.artists.map((a: any) => a.name).join(", ")
          : (album.artists ?? ""),
        artistId: album.artists?.[0]?.id,
        artistList: Array.isArray(album.artists)
          ? album.artists.map((a: any) => ({ id: a.id, name: a.name }))
          : undefined,
      }));
    if (isPlaylistSearchFilter)
      return playlistResults.map((playlist: any) => ({
        ...playlist,
        _type: "playlist",
        coverUrl: playlist.cover
          ? mediaUrl(playlist.cover.url)
          : (playlist.coverUrl ?? ""),
      }));
    return [];
  }, [
    isAllSearchFilter,
    isTrackSearchFilter,
    isArtistSearchFilter,
    isAlbumSearchFilter,
    isPlaylistSearchFilter,
    allResults,
    trackResults,
    artistResults,
    albumResults,
    playlistResults,
  ]);

  const searchLoading = isAllSearchFilter
    ? allLoading
    : isTrackSearchFilter
      ? trackLoading
      : isArtistSearchFilter
        ? artistLoading
        : isAlbumSearchFilter
          ? albumLoading
          : playlistLoading;

  const searchHasLoaded = isAllSearchFilter
    ? allHasLoaded
    : isTrackSearchFilter
      ? trackHasLoaded
      : isArtistSearchFilter
        ? artistHasLoaded
        : isAlbumSearchFilter
          ? albumHasLoaded
          : playlistHasLoaded;

  const isSearchEmpty =
    searchQuery.trim().length >= 2 &&
    !searchLoading &&
    searchHasLoaded &&
    searchResults.length === 0;

  const searchScrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const updateSearchMask = useCallback(() => {
    const el = searchScrollRef.current;
    if (!el) return;
    const { scrollTop, clientHeight, scrollHeight } = el;
    const showTop = scrollTop > 1;
    const showBottom = scrollTop + clientHeight < scrollHeight - 1;

    let stops = "";
    if (showTop) stops += "transparent 0%, black 7%, ";
    else stops += "black 0%, black 7%, ";
    if (showBottom) stops += "black 93%, transparent 100%";
    else stops += "black 93%, black 100%";

    setSearchScrollMask(`linear-gradient(to bottom, ${stops})`);
  }, []);

  useEffect(() => {
    if (!open) {
      // keep the last query around for a minute, so reopening search after
      // closing it by accident doesn't lose what was typed
      const timeoutId = setTimeout(() => {
        setSearchQuery("");
        if (searchInputRef.current) searchInputRef.current.value = "";
      }, SEARCH_QUERY_CACHE_TTL_MS);
      return () => clearTimeout(timeoutId);
    }
    const id = requestAnimationFrame(updateSearchMask);
    requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, updateSearchMask]);

  const runSearchNow = () => {
    if (isAllSearchFilter) {
      runAllSearchNow();
      return;
    }
    if (isTrackSearchFilter) runTrackSearchNow();
    if (isArtistSearchFilter) runArtistSearchNow();
    if (isAlbumSearchFilter) runAlbumSearchNow();
    if (isPlaylistSearchFilter) runPlaylistSearchNow();
  };

  const submitSearchQuery = useCallback(
    (queryToSubmit: string) => {
      const trimmed = queryToSubmit.trim();
      if (!trimmed) return;
      addHistoryItem({
        id: `query:${trimmed.toLowerCase()}`,
        type: "query",
        title: trimmed,
      });
    },
    [addHistoryItem],
  );

  const handleSelectHistoryQuery = useCallback(
    (queryText: string) => {
      setSearchQuery(queryText);
      if (searchInputRef.current) searchInputRef.current.value = queryText;
      submitSearchQuery(queryText);
      searchInputRef.current?.focus();
    },
    [submitSearchQuery],
  );

  const handlePlayFromSearch = useCallback(
    (track: any) => {
      playerEngine.primeUserGesture();
      if (!track) {
        return;
      }
      const durationMs = track.durationMs ?? track.duration_ms;
      const durationStr = durationMs
        ? `${Math.floor(durationMs / 60000)}:${Math.floor(
            (durationMs % 60000) / 1000,
          )
            .toString()
            .padStart(2, "0")}`
        : "";
      addHistoryItem({
        id: track.id,
        type: "track",
        title: track.title,
        subtitle: track.artists,
        coverUrl: track.coverUrl,
        explicit: track.explicit,
        duration: durationStr,
        durationMs,
        itemData: track,
      });
      void playerEngine.playTrack(
        track,
        [track],
        `${track.title} Radio`,
        track.coverUrl,
      );
    },
    [addHistoryItem],
  );

  const handleNavigateItem = useCallback(
    (it: any) => {
      if (
        it._type === "artist" ||
        it.followers !== undefined ||
        activeFilter === "artists"
      ) {
        addHistoryItem({
          id: it.id,
          type: "artist",
          title: it.name || it.title,
          subtitle: t("common.artists"),
          coverUrl: it.coverUrl,
          itemData: it,
        });
        navigate(`/artist?id=${encodeURIComponent(it.id)}`);
        closeSearch();
      } else if (
        it._type === "playlist" ||
        it.owner !== undefined ||
        activeFilter === "playlists"
      ) {
        addHistoryItem({
          id: it.id,
          type: "playlist",
          title: it.name || it.title,
          subtitle: it.author || it.owner || t("common.playlists"),
          coverUrl: it.coverUrl,
          itemData: it,
        });
        navigate(collectionPath("playlist", it.id), {
          state: collectionPreviewState({
            coverUrl: it.coverUrl,
            title: it.name || it.title,
            subtitle: it.author || it.owner,
          }),
        });
        closeSearch();
      } else if (
        it._type === "album" ||
        it.totalTracks !== undefined ||
        it.total_tracks !== undefined ||
        activeFilter === "albums"
      ) {
        addHistoryItem({
          id: it.id,
          type: "album",
          title: it.name || it.title,
          subtitle: it.artists || it.artist || t("common.albums"),
          coverUrl: it.coverUrl,
          itemData: it,
        });
        navigate(collectionPath("album", it.id), {
          state: collectionPreviewState({
            coverUrl: it.coverUrl,
            title: it.name || it.title,
            subtitle: it.artists || it.artist,
          }),
        });
        closeSearch();
      }
    },
    [activeFilter, navigate, addHistoryItem, t, closeSearch],
  );

  return (
    <>
      {/* dims the whole window, header and player included; clicks pass through so
          window controls and dragging keep working, the page is guarded above */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="search-dim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0 z-[50] bg-black/20 pointer-events-none rounded-[inherit]"
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            key="search-popup-wrapper"
            ref={popupRef}
            initial={{ opacity: 0, y: -12, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.99 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 z-[60] flex flex-col items-center pointer-events-none pt-[54px]"
            style={{
              left: SIDEBAR_WIDTH + SHELL_EDGE_GAP,
              right: SHELL_EDGE_GAP,
              top: 6,
            }}
          >
            <div className="w-[min(660px,calc(100vw-72px))] h-[54px] rounded-control pointer-events-auto flex items-center px-[18px] gap-[14px] bg-bg-panel border border-border-primary/50">
              <span className="shrink-0 flex items-center justify-center text-text-tertiary">
                <AnimatePresence mode="wait" initial={false}>
                  {searchLoading ? (
                    <motion.span
                      key="loader"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.1 }}
                      className="inline-block h-[17px] w-[17px] rounded-full border-[1.5px] border-text-secondary border-t-transparent animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <motion.span
                      key="icon"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.1 }}
                      className="inline-flex text-text-tertiary"
                    >
                      <Search3Line size={19} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>

              <input
                ref={searchInputRef}
                type="text"
                placeholder={t("common.search")}
                autoFocus
                defaultValue={searchQuery}
                onChange={(event) => commitTypedQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const value = event.currentTarget.value;
                    commitTypedQuery(value, true);
                    submitSearchQuery(value);
                    // the hooks still hold the previous query in this render;
                    // their own debounce picks up the new one
                    if (value === searchQuery) runSearchNow();
                  }
                }}
                className="w-full flex-1 bg-transparent border-none outline-none text-text-primary text-[16px] placeholder:text-text-tertiary font-[400] tracking-tight"
                style={{
                  lineHeight: "1.2",
                }}
              />

              <AnimatePresence>
                {searchQuery.length > 0 && (
                  <motion.button
                    key="clear-btn"
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{ duration: 0.12 }}
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearchQuery("");
                      commitTypedQuery("", true);
                      if (searchInputRef.current)
                        searchInputRef.current.value = "";
                      searchInputRef.current?.focus();
                    }}
                    className="shrink-0 text-text-tertiary hover:text-text-primary transition-colors border-none bg-transparent p-0 flex items-center justify-center cursor-pointer"
                  >
                    <CloseCircleFill size={18} />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence mode="wait">
              {hasSearchQuery ? (
                <motion.div
                  key="search-results-island"
                  initial={{ opacity: 0, y: -6, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.99 }}
                  transition={{ duration: 0.1, ease: [0.16, 1, 0.3, 1] }}
                  className="w-[min(660px,calc(100vw-72px))] mt-[8px] max-h-[500px] h-[500px] rounded-control pointer-events-auto flex flex-col overflow-hidden bg-bg-panel border border-border-primary/50"
                >
                  <div className="flex gap-[6px] px-[14px] pt-[12px] pb-[6px] shrink-0 overflow-x-auto">
                    {filterKeys.map((key) => {
                      const label = filterLabels[key];
                      const isActive = activeFilter === key;
                      let Icon = GridFill;
                      if (key === "tracks") Icon = Music2Fill;
                      else if (key === "artists") Icon = User2Fill;
                      else if (key === "albums") Icon = AlbumFill;
                      else if (key === "playlists") Icon = PlaylistFill;

                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setActiveFilter(key)}
                          className={`
                            relative flex items-center gap-[7px] px-[13px] py-[7px] rounded-item text-[13.5px] font-normal transition-colors border-none bg-transparent cursor-pointer select-none shrink-0
                            ${
                              isActive
                                ? "text-text-primary font-medium"
                                : "text-text-secondary hover:text-text-primary hover:bg-border-alpha-14"
                            }
                          `}
                          style={{
                            lineHeight: "1.2",
                          }}
                        >
                          {isActive && (
                            <motion.div
                              layoutId="activeFilterPill"
                              className="absolute inset-0 rounded-item bg-border-alpha-14 pointer-events-none z-0"
                              transition={{
                                type: "spring",
                                stiffness: 450,
                                damping: 35,
                              }}
                            />
                          )}
                          <span className="relative z-[1] flex items-center gap-[7px]">
                            <Icon size={15} />
                            <span>{label}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="relative flex-1 min-h-0 overflow-hidden">
                    <AnimatePresence mode="wait">
                      {isSearchEmpty ? (
                        <motion.div
                          key="search-empty"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.08 }}
                          className="flex h-full flex-col items-center justify-center gap-[6px] px-[20px] text-center"
                        >
                          <p className="m-0 text-label text-text-primary font-medium">
                            {t("common.no_results")}
                          </p>
                          <p className="m-0 text-caption text-text-tertiary">
                            {t("common.try_another_search")}
                          </p>
                        </motion.div>
                      ) : searchResults.length > 0 ? (
                        <motion.div
                          key={`search-results-${activeFilter}`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.08 }}
                          className="h-full w-full"
                        >
                          <SearchResultsList
                            items={searchResults}
                            isArtistSearchFilter={isArtistSearchFilter}
                            isPlaylistSearchFilter={isPlaylistSearchFilter}
                            onPlayFromSearch={handlePlayFromSearch}
                            onNavigateItem={handleNavigateItem}
                            onScroll={updateSearchMask}
                            scrollRef={searchScrollRef}
                            maskStyle={{
                              WebkitMaskImage: searchScrollMask,
                              maskImage: searchScrollMask,
                            }}
                            partialWarning={partialWarning}
                          />
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </div>
                </motion.div>
              ) : historyItems.length > 0 ? (
                <motion.div
                  key="search-history-island"
                  initial={{ opacity: 0, y: -6, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.99 }}
                  transition={{ duration: 0.1, ease: [0.16, 1, 0.3, 1] }}
                  className="w-[min(660px,calc(100vw-72px))] mt-[8px] max-h-[480px] h-auto rounded-control pointer-events-auto flex flex-col overflow-hidden bg-bg-panel border border-border-primary/50"
                >
                  <SearchHistoryList
                    onSelectQuery={handleSelectHistoryQuery}
                    onPlayTrack={handlePlayFromSearch}
                    onNavigateItem={handleNavigateItem}
                    onScroll={updateSearchMask}
                    scrollRef={searchScrollRef}
                    maskStyle={{
                      WebkitMaskImage: searchScrollMask,
                      maskImage: searchScrollMask,
                    }}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
