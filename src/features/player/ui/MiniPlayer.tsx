import { memo } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Sidebar,
  SkipNext,
  SkipPrevious,
  MaximizeSquare3,
  PlaybackSpeed,
  Tuning2,
  VolumeCross,
  VolumeSmall,
  VolumeLoud,
  Repeat,
  RepeatOne,
  Shuffle,
} from "@solar-icons/react";
import { HeartFill, HeartLine } from "@mingcute/react";

import { PlayerMorphIcon, ICON_PLAY, ICON_PAUSE } from "./morphPlayerIcons";

import { usePlayerState } from "../hooks/usePlayerState";
import { playerEngine } from "../engine/playerEngine";
import { isRadioContext, nextRepeatMode } from "../engine/radioMode";
import { useTranslation } from "@/languages";
import {
  useIsTrackLiked,
  useLikeTrack,
  useUnlikeTrack,
} from "@/features/library/hooks";
import { usePlayerStore } from "../store/playerStore";
import { toVolumeGain, toVolumeLevel } from "../engine/volume";
import { VolumeColumn } from "./VolumeColumn";
import { SpeedPitchPicker } from "./SpeedPitchPicker";
import { EqualizerPicker } from "./EqualizerPicker";
import { isEqActive } from "../engine/equalizer";
import { TimelineSlider, formatPlaybackTime } from "./TimelineSlider";
import { useTheme } from "next-themes";
import { useCoverReady, CoverImage, loadCoverElement } from "@/features/covers";
import { useHasPageBackdrop } from "@/features/settings/store/customizationStore";
import { ArtistAvatar, ArtistLink } from "@/features/artist";
import { isLocalTrackId } from "@/shared/media/local";
import DropdownMenu from "@/shared/ui/DropdownMenu";
import { useSongMenuItems } from "../hooks/useSongMenuItems";

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const ACCENT_LIGHT = "rgb(23, 23, 23)";
const ACCENT_DARK = "rgb(255, 255, 255)";

function defaultAccentFor(isLight: boolean): string {
  return isLight ? ACCENT_LIGHT : ACCENT_DARK;
}

function extractAccentColor(
  canvas: HTMLCanvasElement,
  isLight: boolean,
): string {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return defaultAccentFor(isLight);

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let totalWeight = 0;
  let weightedR = 0;
  let weightedG = 0;
  let weightedB = 0;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  const count = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    totalR += r;
    totalG += g;
    totalB += b;

    const [, s, l] = rgbToHsl(r, g, b);
    if (l > 0.08 && l < 0.95 && s > 0.1) {
      const vibrancy = s * (1 - Math.abs(l - 0.5) * 1.5);
      const weight = Math.max(0.01, vibrancy * vibrancy);
      weightedR += r * weight;
      weightedG += g * weight;
      weightedB += b * weight;
      totalWeight += weight;
    }
  }

  const finalR = Math.round(
    totalWeight > 0.5 ? weightedR / totalWeight : totalR / count,
  );
  const finalG = Math.round(
    totalWeight > 0.5 ? weightedG / totalWeight : totalG / count,
  );
  const finalB = Math.round(
    totalWeight > 0.5 ? weightedB / totalWeight : totalB / count,
  );

  const [h, s, l] = rgbToHsl(finalR, finalG, finalB);

  if (isLight) {
    if (s < 0.12) return "rgb(30, 30, 30)";
    const solidL = Math.max(0.36, Math.min(0.46, l > 0.55 ? 0.4 : l));
    const solidS = Math.max(0.75, s);
    const [solidR, solidG, solidB] = hslToRgb(h, solidS, solidL);
    return `rgb(${solidR}, ${solidG}, ${solidB})`;
  }

  // Achromatic / monochrome covers fall back to the theme foreground
  if (s < 0.12) return ACCENT_DARK;

  // Keep the accent vibrant and legible on dark backgrounds
  const solidL = Math.max(0.65, Math.min(0.82, l < 0.45 ? 0.7 : l));
  const solidS = Math.max(0.7, s);
  const [solidR, solidG, solidB] = hslToRgb(h, solidS, solidL);
  return `rgb(${solidR}, ${solidG}, ${solidB})`;
}

export interface MiniPlayerProps {
  onQueueOpenChange?: (open: boolean) => void;
  onQueueToggle?: () => void;
  onFullscreenOpen?: () => void;
  embedded?: boolean;
}

function MiniPlayer({
  onQueueOpenChange,
  onQueueToggle,
  onFullscreenOpen,
  embedded = false,
}: MiniPlayerProps) {
  const player = usePlayerState();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme
    ? resolvedTheme === "light"
    : typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-theme") === "light";
  const miniPlayerStyle = usePlayerStore((state) => state.miniPlayerStyle);
  const usesRoundedStyle = !embedded && miniPlayerStyle === "rounded";
  const hasPageBackdrop = useHasPageBackdrop();
  const [accentColorSolid, setAccentColorSolid] = useState(
    defaultAccentFor(isLight),
  );

  const coverUrl = player.currentTrack?.coverUrl || "";

  const applyAccentColor = useCallback(
    (img: HTMLImageElement) => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          setAccentColorSolid(defaultAccentFor(isLight));
          return;
        }
        ctx.drawImage(img, 0, 0, 64, 64);
        setAccentColorSolid(extractAccentColor(canvas, isLight));
      } catch {
        setAccentColorSolid(defaultAccentFor(isLight));
      }
    },
    [isLight],
  );

  useEffect(() => {
    if (!coverUrl) {
      setAccentColorSolid(defaultAccentFor(isLight));
      return;
    }
    let active = true;
    void loadCoverElement(coverUrl).then((img) => {
      if (active && img) applyAccentColor(img);
    });
    return () => {
      active = false;
    };
  }, [coverUrl, isLight, applyAccentColor]);

  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumePinnedRef = useRef(false);
  const [volumePopupStyle, setVolumePopupStyle] = useState<React.CSSProperties>(
    { bottom: 52 },
  );
  const [speedOpen, setSpeedOpen] = useState(false);
  const [speedPopupStyle, setSpeedPopupStyle] = useState<React.CSSProperties>(
    {},
  );
  const [eqOpen, setEqOpen] = useState(false);
  const [eqPopupStyle, setEqPopupStyle] = useState<React.CSSProperties>({});
  const miniPlayerRootRef = useRef<HTMLDivElement>(null);
  const volumePopupRef = useRef<HTMLDivElement>(null);
  const volumeToggleRef = useRef<HTMLButtonElement>(null);
  const speedPopupRef = useRef<HTMLDivElement>(null);
  const speedToggleRef = useRef<HTMLButtonElement>(null);
  const eqPopupRef = useRef<HTMLDivElement>(null);
  const eqToggleRef = useRef<HTMLButtonElement>(null);
  const volumeHoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);

  const currentTrack = player.currentTrack;
  const volumeLevel = toVolumeLevel(player.volume);
  const isLocal = isLocalTrackId(currentTrack?.id);
  const isLiked = useIsTrackLiked(currentTrack?.id);
  const eqActive = isEqActive(player.isEqEnabled, player.eqGains);
  const likeMutation = useLikeTrack();
  const unlikeMutation = useUnlikeTrack();
  const togglingRef = useRef(false);

  const handleLikeToggle = useCallback(() => {
    if (!currentTrack || togglingRef.current) return;
    togglingRef.current = true;
    const onSettled = () => {
      togglingRef.current = false;
    };
    if (isLiked) {
      unlikeMutation.mutate(currentTrack.id, { onSettled });
    } else {
      likeMutation.mutate(currentTrack.id, { onSettled });
    }
  }, [currentTrack, isLiked, likeMutation, unlikeMutation]);

  const durationMs =
    player.durationMs > 0
      ? player.durationMs
      : (player.currentTrack?.durationMs ?? 0);
  const isPlaying = player.status === "playing";
  const isLoading = player.status === "loading";
  const trackTitle = player.currentTrack?.title ?? t("player.nothing_playing");
  const trackArtists = player.currentTrack?.artists ?? t("player.choose_track");

  const isCoverLoaded = useCoverReady(coverUrl);

  const songMenuItems = useSongMenuItems({
    id: currentTrack?.id,
    title: currentTrack?.title ?? "",
    artists: currentTrack?.artists ?? "",
    coverUrl: currentTrack?.coverUrl ?? "",
    durationMs: currentTrack?.durationMs,
  });
  const trackMenuItems = useMemo(
    () =>
      songMenuItems.filter(
        (item) => item.id !== "like-track" && item.id !== "unlike-track",
      ),
    [songMenuItems],
  );
  const [trackMenuPosition, setTrackMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const handleTrackContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!currentTrack || trackMenuItems.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setTrackMenuPosition({ x: event.clientX, y: event.clientY });
    },
    [currentTrack, trackMenuItems.length],
  );

  // off -> all (loop the whole queue/playlist) -> one (loop the track) -> off
  const repeatIcon = useMemo(() => {
    if (player.repeat === "one")
      return <RepeatOne size={18} weight="Outline" />;
    return <Repeat size={18} weight="Outline" />;
  }, [player.repeat]);
  const repeatLabel = t(`player.repeat_${player.repeat}`);

  const activeToggleClass =
    "bg-black/[0.05] dark:bg-white/[0.09] !text-text-primary";

  const iconButtonClass =
    "inline-flex h-[32px] w-[32px] items-center justify-center rounded-control text-text-secondary transition-colors duration-150 hover:bg-black/[0.05] dark:hover:bg-white/[0.09] hover:text-text-primary active:scale-[0.96] border-none bg-transparent cursor-pointer";

  const clearVolumeHoverTimer = useCallback(() => {
    if (volumeHoverCloseTimerRef.current) {
      clearTimeout(volumeHoverCloseTimerRef.current);
      volumeHoverCloseTimerRef.current = null;
    }
  }, []);

  const updateVolumePopupPosition = useCallback(() => {
    const toggle = volumeToggleRef.current;
    const root = miniPlayerRootRef.current;
    if (!toggle || !root) return;
    const toggleRect = toggle.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();

    const popupW = 46;
    const btnW = toggleRect.width;
    const right = rootRect.right - toggleRect.right + (btnW - popupW) / 2;
    const bottom = rootRect.height + 2;

    setVolumePopupStyle({
      right: Math.max(8, right),
      bottom: Math.round(bottom),
    });
  }, []);

  const handleVolumeMouseEnter = useCallback(() => {
    if (speedOpen || eqOpen) return;
    clearVolumeHoverTimer();
    updateVolumePopupPosition();
    setVolumeOpen(true);
  }, [clearVolumeHoverTimer, updateVolumePopupPosition, speedOpen, eqOpen]);

  const handleVolumeMouseLeave = useCallback(() => {
    clearVolumeHoverTimer();
    // Keep open while user is actively dragging the slider
    if (isVolumeDragging || volumePinnedRef.current) return;
    volumeHoverCloseTimerRef.current = setTimeout(() => {
      setVolumeOpen(false);
    }, 140);
  }, [clearVolumeHoverTimer, isVolumeDragging]);

  const handleVolumeWheel = useCallback(
    (e: React.WheelEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.04 : -0.04;
      const nextLevel = Math.min(1, Math.max(0, volumeLevel + delta));
      playerEngine.setVolume(toVolumeGain(nextLevel));
      setVolumeOpen(true);
      clearVolumeHoverTimer();
      if (volumePinnedRef.current) return;
      volumeHoverCloseTimerRef.current = setTimeout(() => {
        setVolumeOpen(false);
      }, 1200);
    },
    [clearVolumeHoverTimer, volumeLevel],
  );

  const handleVolumeDraggingChange = useCallback((dragging: boolean) => {
    setIsVolumeDragging(dragging);
  }, []);

  useEffect(() => {
    return () => {
      clearVolumeHoverTimer();
    };
  }, [clearVolumeHoverTimer]);

  useEffect(() => {
    if (!volumeOpen) {
      volumePinnedRef.current = false;
      return;
    }
    updateVolumePopupPosition();
  }, [volumeOpen, updateVolumePopupPosition]);

  // measured in the click handler, before the popup mounts: positioning it in an
  // effect afterwards moved it on its first open, and framer flew the active
  // preset / tab pills in from the unpositioned spot outside the card
  const popupStyleFor = (toggle: HTMLElement | null): React.CSSProperties => {
    const root = miniPlayerRootRef.current;
    if (!toggle || !root) return {};
    const toggleRect = toggle.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const popupW = 300;
    const btnW = toggleRect.width;
    const right = rootRect.right - toggleRect.right + (btnW - popupW) / 2;
    return { right: Math.max(8, right) };
  };

  useEffect(() => {
    const onDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (volumeOpen) {
        const clickedVolumePopup = volumePopupRef.current?.contains(target);
        const clickedVolumeToggle = volumeToggleRef.current?.contains(target);
        if (!clickedVolumePopup && !clickedVolumeToggle) {
          clearVolumeHoverTimer();
          setVolumeOpen(false);
        }
      }

      if (speedOpen) {
        const clickedSpeedPopup = speedPopupRef.current?.contains(target);
        const clickedSpeedToggle = speedToggleRef.current?.contains(target);
        if (!clickedSpeedPopup && !clickedSpeedToggle) {
          setSpeedOpen(false);
        }
      }

      if (eqOpen) {
        const clickedEqPopup = eqPopupRef.current?.contains(target);
        const clickedEqToggle = eqToggleRef.current?.contains(target);
        if (!clickedEqPopup && !clickedEqToggle) {
          setEqOpen(false);
        }
      }
    };

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (volumeOpen) {
          event.preventDefault();
          event.stopPropagation();
          clearVolumeHoverTimer();
          setVolumeOpen(false);
        }
        if (speedOpen) {
          event.preventDefault();
          event.stopPropagation();
          setSpeedOpen(false);
        }
        if (eqOpen) {
          event.preventDefault();
          event.stopPropagation();
          setEqOpen(false);
        }
      }
    };

    document.addEventListener("mousedown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
    };
  }, [clearVolumeHoverTimer, eqOpen, speedOpen, volumeOpen]);

  return (
    <div
      ref={miniPlayerRootRef}
      className="relative h-[84px] w-full select-none"
    >
      <AnimatePresence>
        {volumeOpen && (
          <motion.div
            key="volume-popup"
            ref={volumePopupRef}
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96, pointerEvents: "none" }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-[88px] z-[99] w-[46px] rounded-[11px] p-[4px] bg-fill backdrop-blur-2xl backdrop-saturate-150 prevent-seek"
            style={volumePopupStyle}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseEnter={clearVolumeHoverTimer}
            onMouseLeave={handleVolumeMouseLeave}
          >
            <div className="absolute inset-x-0 -bottom-[8px] top-0 pointer-events-auto" />

            <VolumeColumn onDraggingChange={handleVolumeDraggingChange} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {speedOpen && (
          <motion.div
            key="speed-popup"
            ref={speedPopupRef}
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-[92px] z-[92] w-[300px] rounded-[14px] p-[16px] bg-fill backdrop-blur-2xl backdrop-saturate-150 prevent-seek"
            style={speedPopupStyle}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <SpeedPitchPicker onClose={() => setSpeedOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {eqOpen && (
          <motion.div
            key="eq-popup"
            ref={eqPopupRef}
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-[92px] z-[92] w-[300px] rounded-[14px] p-[16px] bg-fill backdrop-blur-2xl backdrop-saturate-150 prevent-seek"
            style={eqPopupStyle}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <EqualizerPicker />
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`relative h-[84px] w-full overflow-hidden ${
          usesRoundedStyle
            ? "rounded-full border-[0.5px] border-border-tertiary bg-bg-primary"
            : embedded
              ? `rounded-item ${
                  hasPageBackdrop
                    ? "bg-bg-glass backdrop-blur-[48px] backdrop-saturate-150"
                    : "bg-bg-primary"
                }`
              : "rounded-3xl border-[0.5px] border-border-tertiary bg-bg-primary"
        }`}
      >
        <div className="relative grid h-full grid-cols-[300px_minmax(0,1fr)_288px] pointer-events-none">
          <div
            className="flex h-full items-center gap-[12px] px-[16px] pointer-events-none cursor-default"
            onContextMenu={handleTrackContextMenu}
          >
            {trackMenuPosition && (
              <div className="absolute h-0 w-0 pointer-events-auto">
                <DropdownMenu
                  trigger={<span />}
                  items={trackMenuItems}
                  open
                  onOpenChange={(open) => {
                    if (!open) setTrackMenuPosition(null);
                  }}
                  position={trackMenuPosition}
                />
              </div>
            )}
            <div
              role="button"
              tabIndex={0}
              aria-label="Open player"
              className={`relative h-[56px] w-[56px] shrink-0 overflow-hidden rounded-[10px] bg-bg-elevated cursor-pointer pointer-events-auto prevent-seek ${
                coverUrl && !isCoverLoaded ? "animate-pulse" : ""
              }`}
              onClick={onFullscreenOpen}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <CoverImage
                key={coverUrl}
                src={coverUrl}
                alt="Track artwork"
                width={56}
                height={56}
                priority
                draggable={false}
                onLoad={(e) => {
                  applyAccentColor(e.currentTarget as HTMLImageElement);
                }}
                className="h-[56px] w-[56px] object-cover rounded-[10px]"
              />
            </div>
            <div className="flex min-w-0 flex-col pointer-events-none">
              <p
                className="m-0 truncate text-[17px] font-[500] text-text-primary flex items-center gap-[6px] pointer-events-none"
                style={{
                  lineHeight: "19px",
                  letterSpacing: "0",
                }}
              >
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="Open player"
                  className="min-w-0 truncate cursor-pointer pointer-events-auto prevent-seek"
                  onClick={onFullscreenOpen}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onFullscreenOpen?.();
                    }
                  }}
                >
                  {trackTitle}
                </span>
              </p>
              <p
                className="m-0 mt-[4px] flex min-w-0 items-center gap-[5px] text-body font-[300] text-text-tertiary pointer-events-none"
                style={{
                  lineHeight: "15px",
                }}
              >
                {player.currentTrack?.explicit && (
                  <span className="inline-flex h-[14px] w-[14px] shrink-0 -translate-y-px items-center justify-center rounded-[3.5px] bg-fill-strong text-[8px] font-[600] leading-none text-text-secondary">
                    <span className="translate-y-[0.5px] [text-box:trim-both_cap_alphabetic]">
                      E
                    </span>
                  </span>
                )}
                {!isLocal && (
                  <ArtistAvatar
                    artistId={player.currentTrack?.artistId}
                    artistList={player.currentTrack?.artistList}
                    size={15}
                  />
                )}
                <ArtistLink
                  name={trackArtists}
                  artistId={player.currentTrack?.artistId}
                  artistList={player.currentTrack?.artistList}
                  plain={isLocal}
                  className="text-text-tertiary pointer-events-auto"
                />
              </p>
            </div>
            {!isLocal && (
              <button
                type="button"
                aria-label={isLiked ? "Unlike" : "Like"}
                className={`${iconButtonClass} shrink-0 transition-colors duration-150 pointer-events-auto prevent-seek ${
                  isLiked
                    ? "text-accent-primary"
                    : "text-text-secondary hover:text-text-primary"
                }`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleLikeToggle}
                style={{ cursor: "pointer" }}
              >
                {isLiked ? <HeartFill size={22} /> : <HeartLine size={22} />}
              </button>
            )}
          </div>

          <div className="col-start-3 row-start-1 flex h-full min-w-0 items-center pl-[10px] pr-[18px] pointer-events-none">
            <div
              className="ml-auto flex items-center gap-[2px] pointer-events-auto prevent-seek cursor-default"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                ref={eqToggleRef}
                type="button"
                aria-label={t("player.equalizer")}
                title={t("player.equalizer")}
                className={`${iconButtonClass} ${
                  eqOpen || eqActive ? activeToggleClass : ""
                }`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setVolumeOpen(false);
                  setSpeedOpen(false);
                  onQueueOpenChange?.(false);
                  if (!eqOpen)
                    setEqPopupStyle(popupStyleFor(eqToggleRef.current));
                  setEqOpen((prev) => !prev);
                }}
                style={{ cursor: "pointer" }}
              >
                <motion.div
                  animate={{
                    scale: eqOpen ? 1.08 : 1,
                  }}
                  transition={{ type: "spring", stiffness: 350, damping: 22 }}
                  className="flex items-center justify-center"
                >
                  <Tuning2 size={18} weight={eqActive ? "Bold" : "Outline"} />
                </motion.div>
              </button>
              <button
                ref={speedToggleRef}
                type="button"
                aria-label="Speed and Pitch"
                title={`${t("player.speed_pitch")}: x${(player.playbackRate ?? 1).toFixed(2)}`}
                className={`${iconButtonClass} ${
                  speedOpen ||
                  Math.abs((player.playbackRate ?? 1) - 1) > 0.001 ||
                  Math.abs(player.pitchSemitones ?? 0) > 0.001
                    ? activeToggleClass
                    : ""
                }`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  clearVolumeHoverTimer();
                  setVolumeOpen(false);
                  setEqOpen(false);
                  onQueueOpenChange?.(false);
                  if (!speedOpen)
                    setSpeedPopupStyle(popupStyleFor(speedToggleRef.current));
                  setSpeedOpen((prev) => !prev);
                }}
                style={{ cursor: "pointer" }}
              >
                <motion.div
                  animate={{
                    scale: speedOpen ? 1.08 : 1,
                  }}
                  transition={{ type: "spring", stiffness: 350, damping: 22 }}
                  className="flex items-center justify-center"
                >
                  <PlaybackSpeed
                    size={18}
                    weight={
                      Math.abs((player.playbackRate ?? 1) - 1) > 0.001 ||
                      Math.abs(player.pitchSemitones ?? 0) > 0.001
                        ? "Bold"
                        : "Outline"
                    }
                  />
                </motion.div>
              </button>
              <button
                ref={volumeToggleRef}
                type="button"
                aria-label="Volume"
                className={`${iconButtonClass} ${
                  volumeOpen ? "bg-bg-toolbox-active text-text-primary" : ""
                }`}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseEnter={handleVolumeMouseEnter}
                onMouseLeave={handleVolumeMouseLeave}
                onWheel={handleVolumeWheel}
                onClick={(e) => {
                  e.stopPropagation();
                  clearVolumeHoverTimer();
                  if (volumeOpen && volumePinnedRef.current) {
                    setVolumeOpen(false);
                    return;
                  }
                  volumePinnedRef.current = true;
                  updateVolumePopupPosition();
                  setSpeedOpen(false);
                  setEqOpen(false);
                  onQueueOpenChange?.(false);
                  setVolumeOpen(true);
                }}
                style={{ cursor: "pointer" }}
              >
                {volumeLevel === 0 ? (
                  <VolumeCross size={18} weight="Outline" />
                ) : volumeLevel < 0.33 ? (
                  <VolumeSmall size={18} weight="Outline" />
                ) : (
                  <VolumeLoud size={18} weight="Outline" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(volumeLevel * 100)}
                aria-label={t("player.volume") || "Volume"}
                title={`${t("player.volume") || "Volume"}: ${Math.round(volumeLevel * 100)}%`}
                onChange={(e) =>
                  playerEngine.setVolume(
                    toVolumeGain(Number(e.target.value) / 100),
                  )
                }
                onPointerDown={(e) => e.stopPropagation()}
                className="prevent-seek h-[14px] w-[68px] shrink-0 cursor-pointer bg-transparent"
                style={{ accentColor: accentColorSolid }}
              />
              <button
                type="button"
                aria-label={t("player.open_player")}
                title={t("player.open_player")}
                className={iconButtonClass}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setSpeedOpen(false);
                  setEqOpen(false);
                  setVolumeOpen(false);
                  onFullscreenOpen?.();
                }}
              >
                <MaximizeSquare3 size={18} weight="Outline" />
              </button>
              <button
                type="button"
                aria-label={t("player.queue")}
                title={t("player.queue")}
                className={iconButtonClass}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setSpeedOpen(false);
                  setEqOpen(false);
                  setVolumeOpen(false);
                  onQueueToggle?.();
                }}
                style={{ cursor: "pointer" }}
              >
                <Sidebar size={18} weight="Outline" />
              </button>
            </div>
          </div>

          <div className="col-start-2 row-start-1 flex h-full min-w-0 items-center justify-center px-1 pointer-events-none">
            <div
              className="pointer-events-auto flex w-full min-w-0 max-w-[620px] flex-col items-center gap-[4px] prevent-seek cursor-default"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-[6px]">
                <button
                  type="button"
                  aria-label="Shuffle"
                  title={
                    player.shuffle
                      ? t("player.shuffle_on")
                      : t("player.shuffle_off")
                  }
                  className={`${iconButtonClass} ${
                    player.shuffle ? activeToggleClass : ""
                  }`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => playerEngine.setShuffle(!player.shuffle)}
                >
                  <Shuffle size={18} weight="Outline" />
                </button>
                <button
                  type="button"
                  aria-label="Previous track"
                  className={`${iconButtonClass} text-text-secondary hover:text-text-primary`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    void playerEngine.skipPrevious();
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <SkipPrevious size={18} weight="Bold" />
                </button>
                <button
                  type="button"
                  aria-label={isPlaying ? "Pause" : "Play"}
                  className="inline-flex h-[40px] w-[40px] items-center justify-center rounded-full transition-all duration-150 ease-out hover:scale-105 active:scale-[0.96] border-none cursor-pointer shadow-sm"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    void playerEngine.togglePlayPause();
                  }}
                  style={{
                    backgroundColor: accentColorSolid,
                    color: isLight ? "#ffffff" : "#0a0a0a",
                    cursor: "pointer",
                  }}
                >
                  {/* keep the morph icon mounted through the loading state
                  (spinner overlays it) — swapping it out on "loading" would
                  remount MorphIcon when the track starts, which skips the
                  play -> pause morph animation. */}
                  <span className="relative flex h-[16px] w-[16px] items-center justify-center">
                    <span
                      className={`absolute inset-0 flex items-center justify-center ${
                        isLoading ? "opacity-0" : ""
                      } transition-transform ${
                        isPlaying ? "" : "translate-x-[0.5px]"
                      }`}
                    >
                      <PlayerMorphIcon
                        icon={isPlaying ? ICON_PAUSE : ICON_PLAY}
                        size={16}
                      />
                    </span>
                    {isLoading && (
                      <span
                        className="absolute h-[16px] w-[16px] animate-spin rounded-full border-[2px] border-current border-t-transparent"
                        aria-label="Loading playback"
                      />
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Next track"
                  className={`${iconButtonClass} text-text-secondary hover:text-text-primary`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    void playerEngine.skipNext();
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <SkipNext size={18} weight="Bold" />
                </button>
                <button
                  type="button"
                  aria-label={repeatLabel}
                  title={repeatLabel}
                  className={`${iconButtonClass} ${
                    player.repeat !== "off" ? activeToggleClass : ""
                  }`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() =>
                    playerEngine.setRepeat(
                      // radio has no repeat-all: it refills instead of looping
                      nextRepeatMode(
                        player.repeat,
                        isRadioContext(player.playbackContext),
                      ),
                    )
                  }
                >
                  {repeatIcon}
                </button>
              </div>
              <div className="flex w-full items-center gap-[12px]">
                <span className="w-[36px] shrink-0 text-right text-[12px] font-[400] tabular-nums text-text-tertiary">
                  {formatPlaybackTime(player.positionMs)}
                </span>
                <TimelineSlider
                  positionMs={player.positionMs}
                  durationMs={durationMs}
                  onSeek={(pos) =>
                    playerEngine.seek(pos, false, { fast: true })
                  }
                  size="xs"
                  fillColor={accentColorSolid || undefined}
                  trackBg={
                    isLight
                      ? "rgba(0, 0, 0, 0.10)"
                      : "rgba(255, 255, 255, 0.16)"
                  }
                  trackActiveBg={
                    isLight
                      ? "rgba(0, 0, 0, 0.18)"
                      : "rgba(255, 255, 255, 0.30)"
                  }
                  className="flex-1"
                />
                <span className="w-[36px] shrink-0 text-[12px] font-[400] tabular-nums text-text-tertiary">
                  {formatPlaybackTime(durationMs)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(MiniPlayer);
