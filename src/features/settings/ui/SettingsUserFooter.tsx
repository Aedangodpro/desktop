import { ExitLine } from "@mingcute/react";
import { useNavigate } from "react-router-dom";
import { Button, UserAvatar } from "@/shared/ui";
import { useTranslation } from "@/languages";
import { useAuthStore } from "@/features/auth";
import { userDisplayName } from "@/entities/user";

interface SettingsUserFooterProps {
  onClose: () => void;
}

export function SettingsUserFooter({ onClose }: SettingsUserFooterProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const status = useAuthStore((state) => state.status);
  const logout = useAuthStore((state) => state.logout);

  // A guest has no profile yet. Showing the account card with a sign-out icon
  // made the guest path read like a broken session, so it gets its own card
  // with the one action it actually has.
  if (!user) {
    if (status === "initializing") return null;
    return (
      <div className="shrink-0 px-[10px] pt-[6px] pb-[10px]">
        <div className="flex flex-col gap-[8px] rounded-item bg-fill p-[8px]">
          <div className="flex min-w-0 items-center gap-[10px]">
            <span className="shrink-0">
              <UserAvatar user={null} size={32} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-[2px] font-sans">
              <span className="truncate text-body leading-[16px] font-[500] text-text-primary">
                {t("settings.guest.title")}
              </span>
              <span className="truncate text-caption leading-[15px] text-text-tertiary">
                {t("settings.guest.subtitle")}
              </span>
            </span>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => {
              onClose();
              navigate("/login");
            }}
          >
            {t("settings.guest.sign_in")}
          </Button>
        </div>
      </div>
    );
  }

  const displayName = userDisplayName(user) ?? "Liner";
  const handle = user.username
    ? `@${user.username}`
    : (user.email ?? t("settings.manage_account"));
  const signOutLabel = t("settings.profile.sign_out") || "Log out";

  return (
    <div className="shrink-0 px-[10px] pt-[6px] pb-[10px]">
      <div className="flex min-w-0 items-center gap-[10px] rounded-item bg-fill p-[8px] pr-[6px]">
        <span className="relative shrink-0">
          <UserAvatar user={user ?? null} size={32} />
          <span
            aria-hidden
            className="absolute right-[-1px] bottom-[-1px] h-[9px] w-[9px] rounded-full bg-emerald-500"
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[2px] font-sans">
          <span className="truncate text-body leading-[16px] font-[500] text-text-primary">
            {displayName}
          </span>
          <span className="truncate text-caption leading-[15px] text-text-tertiary">
            {handle}
          </span>
        </span>
        <button
          type="button"
          onClick={async () => {
            onClose();
            await logout();
          }}
          title={signOutLabel}
          aria-label={signOutLabel}
          className="flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-tertiary transition-colors hover:bg-red-500/10 hover:text-red-500"
        >
          <ExitLine size={16} />
        </button>
      </div>
    </div>
  );
}
