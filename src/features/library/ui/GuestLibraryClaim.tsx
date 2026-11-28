import { useCallback, useEffect, useState } from "react";
import Dialog from "@/shared/ui/Dialog";
import Button from "@/shared/ui/Button";
import { useToast } from "@/shared/ui";
import { useTranslation } from "@/languages";
import { useAuthStore } from "@/features/auth";
import {
  claimLocalLibrary,
  dismissClaimPrompt,
  isClaimPromptDismissed,
  pendingLocalClaim,
  type LocalClaimPending,
} from "../local-account/claim/claimLocalLibrary";

const EMPTY: LocalClaimPending = { playlists: 0, tracks: 0, liked: 0 };

/**
 * Offers to copy the guest library into the account after sign-in. Mounted at
 * the app root because signing in leaves `/login` immediately.
 */
export default function GuestLibraryClaim() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const status = useAuthStore((state) => state.status);
  const [pending, setPending] = useState<LocalClaimPending>(EMPTY);
  const [open, setOpen] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    if (status !== "authenticated") {
      setOpen(false);
      return;
    }
    const next = pendingLocalClaim();
    setPending(next);
    setOpen(
      (next.playlists > 0 || next.liked > 0) && !isClaimPromptDismissed(),
    );
  }, [status]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener("library:changed", refresh);
    return () => window.removeEventListener("library:changed", refresh);
  }, [refresh]);

  const dismiss = () => {
    dismissClaimPrompt();
    setOpen(false);
  };

  const confirm = async () => {
    if (claiming) return;
    setClaiming(true);
    setError("");
    setProgress({ done: 0, total: pending.tracks + pending.liked });
    try {
      const result = await claimLocalLibrary({
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (result.failed > 0) {
        // Unfinished playlists keep no claim marker, so the button retries.
        setPending(pendingLocalClaim());
        setError(t("local_claim.partial"));
        return;
      }
      toast.success(t("local_claim.success"), {
        description: t("local_claim.success_detail", {
          count: result.tracks,
          liked: result.liked,
        }),
      });
      setPending(EMPTY);
      setOpen(false);
    } catch {
      setError(t("local_claim.failed"));
    } finally {
      setClaiming(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !claiming) dismiss();
      }}
      maxWidth={400}
    >
      <div className="flex flex-col px-[22px] pb-[18px] pt-[20px]">
        <h2 className="m-0 text-heading font-[600] leading-[1.2] tracking-[-0.01em] text-text-primary">
          {t("local_claim.title")}
        </h2>
        <p className="m-0 mt-[8px] text-body leading-[1.5] text-text-secondary">
          {t("local_claim.body")}
        </p>
        <p className="m-0 mt-[10px] text-caption text-text-tertiary">
          {t("local_claim.detail", {
            count: pending.playlists,
            tracks: pending.tracks,
            liked: pending.liked,
          })}
        </p>

        {error && (
          <p
            role="alert"
            className="m-0 mt-[10px] text-caption font-[500] leading-[1.4] text-accent-primary"
          >
            {error}
          </p>
        )}

        {claiming && (
          <p className="m-0 mt-[10px] flex items-center gap-[8px] text-caption text-text-tertiary">
            <span className="h-[12px] w-[12px] shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span>
              {progress.total > 0
                ? t("local_claim.working_progress", progress)
                : t("local_claim.working")}
            </span>
          </p>
        )}

        <div className="mt-[18px] flex items-center gap-[8px]">
          <Button
            type="button"
            variant="outline"
            disabled={claiming}
            onClick={dismiss}
            className="flex-1"
          >
            {t("local_claim.skip")}
          </Button>
          <Button
            type="button"
            disabled={claiming}
            onClick={() => void confirm()}
            className="flex-1"
          >
            {t("local_claim.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
