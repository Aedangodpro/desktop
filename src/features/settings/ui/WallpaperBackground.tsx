import { CUSTOM_WALLPAPER_ID, findWallpaper } from "../wallpapers/wallpapers";
import { useWallpaperStore } from "../wallpapers/wallpaperStore";

/**
 * Sits under everything else in the app frame. The palette drawn from this
 * image is on the document root (`--wallpaper-tint`, `--wallpaper-glow`), so
 * the wash and the accent colours stay in step with the wallpaper.
 */
export default function WallpaperBackground() {
  const selectedId = useWallpaperStore((state) => state.selectedId);
  const custom = useWallpaperStore((state) => state.custom);
  const src =
    findWallpaper(selectedId)?.src ??
    (selectedId === CUSTOM_WALLPAPER_ID ? custom?.dataUrl : undefined);
  if (!src) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 select-none overflow-hidden rounded-item"
    >
      <img
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        className="absolute inset-0 h-full w-full select-none object-cover"
        style={{
          filter: "blur(22px) saturate(125%)",
          transform: "scale(1.12)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{ backgroundColor: "var(--wallpaper-tint, transparent)" }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(115% 80% at 50% -10%, var(--wallpaper-glow, transparent), transparent 68%)",
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-white/35 via-white/25 to-white/45 dark:from-black/40 dark:via-black/30 dark:to-black/55" />
    </div>
  );
}
