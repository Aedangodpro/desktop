import { useTranslation } from "@/languages";
import { useLyricsStore } from "../store/lyricsStore";

/**
 * A line-synced track still sweeps word by word, but those word times are
 * spread evenly from the line start instead of coming from the vocal, so the
 * highlight can drift through instrumental gaps. This is the smallest honest
 * note about that: a caption in the top notch next to the provider name, low
 * contrast and never over the lyrics themselves.
 */
export function LyricsSyncBadge() {
  const syncLevel = useLyricsStore((state) => {
    const active = state.activeProvider;
    if (!active) return null;
    const option = state.availableProviders.find((p) => p.provider === active);
    return option?.syncLevel ?? option?.candidate?.syncLevel ?? null;
  });
  const { t } = useTranslation();
  if (syncLevel !== "line_level") return null;
  return (
    <span
      title={t("player.line_synced_hint")}
      className="flex h-[26px] items-center gap-[5px] px-[6px] text-white/45 select-none"
    >
      <span aria-hidden className="h-[3px] w-[3px] rounded-full bg-current" />
      <span className="text-caption leading-[26px] font-[500] whitespace-nowrap">
        {t("player.line_synced")}
      </span>
    </span>
  );
}
