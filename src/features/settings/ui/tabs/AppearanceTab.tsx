import { useState, useEffect } from "react";
import { useTranslation, LOCALE_OPTIONS } from "@/languages";
import { useFpsOverlayStore } from "@/features/player";
import { MenuSelect, ToggleSwitch } from "@/shared/ui";
import { SettingRow, SettingSection } from "../controls";

export function AppearanceTab({ searchQuery }: { searchQuery?: string }) {
  const { t, locale, setLocale } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const fpsOverlay = useFpsOverlayStore((state) => state.enabled);
  const setFpsOverlay = useFpsOverlayStore((state) => state.setEnabled);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <SettingSection>
      <SettingRow
        title={t("settings.language.label")}
        description={t("settings.language.description")}
        titleKey="settings.language.label"
        descKey="settings.language.description"
        searchQuery={searchQuery}
        control={
          mounted ? (
            <MenuSelect
              options={LOCALE_OPTIONS}
              value={locale}
              onChange={setLocale}
              className="min-w-[130px]"
              aria-label={t("settings.language.label")}
            />
          ) : (
            <span />
          )
        }
      />

      <SettingRow
        title={t("settings.fps_overlay.title")}
        description={t("settings.fps_overlay.description")}
        titleKey="settings.fps_overlay.title"
        descKey="settings.fps_overlay.description"
        searchQuery={searchQuery}
        control={
          mounted ? (
            <ToggleSwitch
              checked={fpsOverlay}
              onChange={setFpsOverlay}
              ariaLabel={t("settings.fps_overlay.title")}
            />
          ) : (
            <span />
          )
        }
      />
    </SettingSection>
  );
}
