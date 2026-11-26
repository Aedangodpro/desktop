import type { LibraryTab } from "../types";
import { useTranslation } from "@/languages";
import Button from "@/shared/ui/Button";
import { HERO_BUTTON_CLASS, HERO_GLASS_BUTTON_CLASS } from "@/shared/ui";

interface LibraryTabsProps {
  activeTab: LibraryTab;
  onChange: (tab: LibraryTab) => void;
  /** Albums and artists are saved to an account, so guests have no tabs for them. */
  showAccountTabs?: boolean;
}

const tabs: LibraryTab[] = ["all", "playlists", "albums", "artists"];
const accountTabs: ReadonlySet<LibraryTab> = new Set(["albums", "artists"]);

export default function LibraryTabs({
  activeTab,
  onChange,
  showAccountTabs = true,
}: LibraryTabsProps) {
  const { t } = useTranslation();
  const visibleTabs = showAccountTabs
    ? tabs
    : tabs.filter((tab) => !accountTabs.has(tab));

  const tabLabels: Record<LibraryTab, string> = {
    all: t("library.tab_all"),
    playlists: t("library.tab_playlists"),
    albums: t("library.tab_albums"),
    artists: t("library.tab_artists"),
  };

  return (
    <div className="flex items-center gap-[8px]" role="tablist">
      {visibleTabs.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <Button
            key={tab}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab)}
            variant={isActive ? "primary" : "secondary"}
            className={`${HERO_BUTTON_CLASS} px-[16px] ${
              isActive ? "" : `${HERO_GLASS_BUTTON_CLASS} text-text-primary`
            }`}
          >
            {tabLabels[tab]}
          </Button>
        );
      })}
    </div>
  );
}
