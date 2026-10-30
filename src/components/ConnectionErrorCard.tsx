import { useState } from "react";
import { AlertCircle, Copy, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { isProfileCheckCancelled, profileCheckDetails } from "@/lib/profileCheck";
import { copyTextToClipboard } from "@/lib/diagnostics";

export function ConnectionErrorCard({ error, onDismiss }: { error: string; onDismiss?: () => void }) {
  const { t } = useI18n();
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const details = profileCheckDetails(error, t);
  if (dismissedError === error || isProfileCheckCancelled(error)) return null;

  const copyReport = async () => {
    if (!details) return;
    try {
      await copyTextToClipboard(details.report);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-foreground">
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2 break-words">
          {details ? (
            <>
              <h2 className="font-semibold">{details.title}</h2>
              <p>{details.reason}</p>
              <p className="text-foreground/90"><span className="font-medium">{t("profileCheck.nextStep")}: </span>{details.action}</p>
              <button
                type="button"
                onClick={() => void copyReport()}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-destructive/25 px-2 py-1 hover:bg-destructive/10"
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                {copyState === "copied" ? t("common.copied") : t("profileCheck.copyReport")}
              </button>
              {copyState === "failed" && <p role="status">{t("profileCheck.copyUnavailable")}</p>}
            </>
          ) : <p>{error}</p>}
        </div>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => { setDismissedError(error); onDismiss?.(); }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-destructive/10"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}
