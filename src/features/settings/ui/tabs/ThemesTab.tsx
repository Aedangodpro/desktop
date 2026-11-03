import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslation } from "@/languages";
import { cn, revealThemeChange } from "@/shared/lib";
import {
  ACCENT_THEMES,
  getStoredAccentId,
  setAccentTheme,
} from "@/shared/utils/accentTheme";
import { SettingBlock, SettingSection } from "../controls";
import { ThemeCard } from "./ThemeCard";

export function ThemesTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [accent, setAccent] = useState(getStoredAccentId());

  useEffect(() => {
    setMounted(true);
    setAccent(getStoredAccentId());
  }, []);

  return (
    <SettingSection>
      <SettingBlock
        title={t("settings.theme.title")}
        description={t("settings.theme.description")}
        titleKey="settings.theme.title"
        descKey="settings.theme.description"
        searchQuery={searchQuery}
      >
        {mounted ? (
          <div className="grid grid-cols-3 gap-[10px]">
            {(
              [
                { value: "system", label: t("settings.theme.system") },
                { value: "light", label: t("settings.theme.light") },
                { value: "dark", label: t("settings.theme.dark") },
              ] as const
            ).map((item) => (
              <ThemeCard
                key={item.value}
                mode={item.value}
                label={item.label}
                active={theme === item.value}
                onSelect={(event) =>
                  revealThemeChange(() => setTheme(item.value), {
                    x: event.clientX,
                    y: event.clientY,
                  })
                }
              />
            ))}
          </div>
        ) : null}
      </SettingBlock>

      <SettingBlock
        title={t("settings.accent.title")}
        description={t("settings.accent.description")}
        titleKey="settings.accent.title"
        descKey="settings.accent.description"
        searchQuery={searchQuery}
      >
        {mounted ? (
          <div className="grid grid-cols-3 gap-[10px]">
            {ACCENT_THEMES.map((item) => {
              const active = accent === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setAccentTheme(item.id);
                    setAccent(item.id);
                  }}
                  className={cn(
                    "group flex cursor-pointer flex-col gap-[8px] rounded-item border-0 p-[6px] pb-[9px] text-left transition-colors",
                    active ? "bg-fill-hover" : "bg-fill hover:bg-fill-hover",
                  )}
                >
                  <span className="flex h-[52px] w-full items-center justify-center gap-[6px] overflow-hidden rounded-control bg-bg-surface">
                    <span
                      className="h-[24px] w-[24px] rounded-full"
                      style={{ background: item.accent }}
                    />
                    <span
                      className="h-[24px] w-[24px] rounded-full"
                      style={{ background: item.secondary }}
                    />
                    <span
                      className="h-[24px] w-[24px] rounded-full"
                      style={{ background: item.tertiary }}
                    />
                  </span>
                  <span className="flex items-center gap-[8px] px-[3px]">
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors",
                        active
                          ? "border-text-primary"
                          : "border-text-tertiary group-hover:border-text-secondary",
                      )}
                    >
                      {active ? (
                        <span className="h-[6px] w-[6px] rounded-full bg-text-primary" />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "text-body leading-none",
                        active ? "text-text-primary" : "text-text-secondary",
                      )}
                      style={{ fontWeight: active ? 500 : 400 }}
                    >
                      {item.label}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="mt-[10px] flex items-center gap-[10px] rounded-item bg-fill p-[12px]">
          <span className="h-[10px] w-[10px] shrink-0 rounded-full bg-accent-primary" />
          <span className="text-body text-text-primary">
            {t("settings.accent.preview") || "Preview"}
          </span>
          <span className="ml-auto flex items-center gap-[6px]">
            <span className="h-[3px] w-[90px] overflow-hidden rounded-full bg-fill-strong">
              <span className="block h-full w-[62%] rounded-full bg-accent-primary" />
            </span>
            <span className="text-caption text-accent-primary">Aa</span>
          </span>
        </div>
      </SettingBlock>
    </SettingSection>
  );
}
