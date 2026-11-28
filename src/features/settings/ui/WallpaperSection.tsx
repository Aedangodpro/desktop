import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AddLine, CheckLine, CloseLine } from "@mingcute/react";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib/utils";
import { SettingBlock, SettingSection } from "./controls";
import { useIsDarkTheme } from "../store/customizationStore";
import { ensureWallpaperPalette } from "../wallpapers/wallpaperPalettes";
import type { WallpaperPalette } from "../wallpapers/wallpaperPalette";
import { useWallpaperStore } from "../wallpapers/wallpaperStore";
import {
  canPersistWallpaper,
  readWallpaperFile,
  WallpaperUploadError,
  type WallpaperUploadErrorCode,
} from "../wallpapers/wallpaperUpload";
import {
  CUSTOM_WALLPAPER_ID,
  WALLPAPERS,
  type Wallpaper,
} from "../wallpapers/wallpapers";

const UPLOAD_ERROR_KEYS: Record<WallpaperUploadErrorCode, string> = {
  type: "settings.wallpaper.error_type",
  size: "settings.wallpaper.error_size",
  storage: "settings.wallpaper.error_storage",
  failed: "settings.wallpaper.error_failed",
};

function SelectedBadge() {
  return (
    <span className="absolute right-[7px] top-[7px] flex h-[18px] w-[18px] items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm">
      <CheckLine size={12} />
    </span>
  );
}

function SwatchStrip({ palette }: { palette: WallpaperPalette }) {
  return (
    <span className="absolute bottom-[6px] left-[6px] flex items-center gap-[3px] rounded-full bg-black/35 px-[5px] py-[3px] backdrop-blur-sm">
      {palette.swatches.map((color, index) => (
        <span
          key={`${color}-${index}`}
          className="h-[6px] w-[6px] rounded-full ring-1 ring-white/20"
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}

function WallpaperCard({
  wallpaper,
  selected,
  onSelect,
}: {
  wallpaper: Wallpaper;
  selected: boolean;
  onSelect: () => void;
}) {
  const isDark = useIsDarkTheme();
  const palette = useWallpaperStore(
    (state) => state.palettes[wallpaper.id]?.[isDark ? "dark" : "light"],
  );

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={wallpaper.name}
      onClick={onSelect}
      className={cn(
        "group overflow-hidden rounded-item border bg-transparent p-0 text-left transition-colors",
        selected
          ? "border-accent-primary"
          : "border-border-alpha-14 hover:border-border-alpha-33",
      )}
    >
      <span className="relative block aspect-[16/9] w-full overflow-hidden">
        <img
          src={wallpaper.src}
          alt=""
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
        />
        {palette ? <SwatchStrip palette={palette} /> : null}
        {selected ? <SelectedBadge /> : null}
      </span>
      <span className="block truncate px-[9px] py-[7px] text-body font-[500] text-text-primary">
        {wallpaper.name}
      </span>
    </button>
  );
}

export function WallpaperSection({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const isDark = useIsDarkTheme();
  const selectedId = useWallpaperStore((state) => state.selectedId);
  const setSelectedId = useWallpaperStore((state) => state.setSelectedId);
  const custom = useWallpaperStore((state) => state.custom);
  const setCustomWallpaper = useWallpaperStore(
    (state) => state.setCustomWallpaper,
  );
  const clearCustomWallpaper = useWallpaperStore(
    (state) => state.clearCustomWallpaper,
  );
  const customPalette = useWallpaperStore(
    (state) => state.palettes[CUSTOM_WALLPAPER_ID]?.[isDark ? "dark" : "light"],
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // Sample every wallpaper up front so each card can show the colours it will
  // bring, and the first click recolours the app without a visible wait.
  useEffect(() => {
    let active = true;
    void (async () => {
      for (const wallpaper of WALLPAPERS) {
        if (!active) return;
        await ensureWallpaperPalette(wallpaper.id, isDark ? "dark" : "light");
      }
      if (active && custom) {
        await ensureWallpaperPalette(
          CUSTOM_WALLPAPER_ID,
          isDark ? "dark" : "light",
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [isDark, custom]);

  const openPicker = () => {
    if (busy) return;
    setErrorKey(null);
    inputRef.current?.click();
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const { dataUrl, name } = await readWallpaperFile(file);
      if (!canPersistWallpaper(dataUrl)) {
        throw new WallpaperUploadError("storage");
      }
      setCustomWallpaper({
        dataUrl,
        name: name || t("settings.wallpaper.custom"),
      });
    } catch (error) {
      const code =
        error instanceof WallpaperUploadError ? error.code : "failed";
      setErrorKey(UPLOAD_ERROR_KEYS[code]);
    } finally {
      setBusy(false);
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // reset so picking the same file again still fires a change event
    event.target.value = "";
    void handleFile(file);
  };

  const customSelected = selectedId === CUSTOM_WALLPAPER_ID;

  return (
    <SettingSection>
      <SettingBlock
        title={t("settings.wallpaper.title")}
        description={t("settings.wallpaper.description")}
        titleKey="settings.wallpaper.title"
        descKey="settings.wallpaper.description"
        searchQuery={searchQuery}
      >
        <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-3">
          <button
            type="button"
            aria-pressed={selectedId === null}
            aria-label={t("settings.wallpaper.plain")}
            onClick={() => setSelectedId(null)}
            className={cn(
              "group overflow-hidden rounded-item border bg-transparent p-0 text-left transition-colors",
              selectedId === null
                ? "border-accent-primary"
                : "border-border-alpha-14 hover:border-border-alpha-33",
            )}
          >
            <span className="relative block aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-bg-primary via-bg-elevated to-bg-panel">
              {selectedId === null ? <SelectedBadge /> : null}
            </span>
            <span className="block truncate px-[9px] py-[7px] text-body font-[500] text-text-primary">
              {t("settings.wallpaper.plain")}
            </span>
          </button>

          {WALLPAPERS.map((wallpaper) => (
            <WallpaperCard
              key={wallpaper.id}
              wallpaper={wallpaper}
              selected={selectedId === wallpaper.id}
              onSelect={() => setSelectedId(wallpaper.id)}
            />
          ))}

          {custom ? (
            <div
              className={cn(
                "group relative overflow-hidden rounded-item border text-left transition-colors",
                customSelected
                  ? "border-accent-primary"
                  : "border-border-alpha-14 hover:border-border-alpha-33",
              )}
            >
              <button
                type="button"
                aria-pressed={customSelected}
                aria-label={custom.name}
                onClick={() => setSelectedId(CUSTOM_WALLPAPER_ID)}
                className="block w-full cursor-pointer overflow-hidden border-0 bg-transparent p-0 text-left"
              >
                <span className="relative block aspect-[16/9] w-full overflow-hidden">
                  <img
                    src={custom.dataUrl}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
                  />
                  {customPalette ? (
                    <SwatchStrip palette={customPalette} />
                  ) : null}
                  {customSelected ? <SelectedBadge /> : null}
                </span>
                <span className="block truncate px-[9px] py-[7px] text-body font-[500] text-text-primary">
                  {busy ? t("settings.wallpaper.reading") : custom.name}
                </span>
              </button>
              <span className="absolute left-[6px] top-[6px] flex items-center gap-[4px]">
                <button
                  type="button"
                  aria-label={t("settings.wallpaper.replace")}
                  title={t("settings.wallpaper.replace")}
                  disabled={busy}
                  onClick={openPicker}
                  className="flex h-[19px] w-[19px] cursor-pointer items-center justify-center rounded-full border-0 bg-black/45 p-0 text-white backdrop-blur-sm transition-colors hover:bg-black/65 disabled:cursor-wait"
                >
                  <AddLine size={11} />
                </button>
                <button
                  type="button"
                  aria-label={t("settings.wallpaper.remove")}
                  title={t("settings.wallpaper.remove")}
                  onClick={() => {
                    setErrorKey(null);
                    clearCustomWallpaper();
                  }}
                  className="flex h-[19px] w-[19px] cursor-pointer items-center justify-center rounded-full border-0 bg-black/45 p-0 text-white backdrop-blur-sm transition-colors hover:bg-black/65"
                >
                  <CloseLine size={11} />
                </button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              aria-pressed={false}
              aria-label={t("settings.wallpaper.choose")}
              aria-busy={busy}
              disabled={busy}
              onClick={openPicker}
              className="group overflow-hidden rounded-item border border-dashed border-border-alpha-14 bg-transparent p-0 text-left transition-colors hover:border-border-alpha-33 disabled:cursor-wait"
            >
              <span className="relative flex aspect-[16/9] w-full flex-col items-center justify-center gap-[5px] bg-fill/30">
                {busy ? (
                  <span className="text-caption text-text-tertiary">
                    {t("settings.wallpaper.reading")}
                  </span>
                ) : (
                  <AddLine size={20} className="text-text-tertiary" />
                )}
                <span className="text-caption text-text-tertiary">
                  {t("settings.wallpaper.custom")}
                </span>
              </span>
              <span className="block truncate px-[9px] py-[7px] text-body font-[500] text-text-primary">
                {t("settings.wallpaper.choose")}
              </span>
            </button>
          )}
        </div>

        {errorKey ? (
          <p
            role="alert"
            className="m-0 text-caption leading-[16px] text-red-400"
          >
            {t(errorKey)}
          </p>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleInputChange}
        />
      </SettingBlock>
    </SettingSection>
  );
}
