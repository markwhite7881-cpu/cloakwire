import { useState } from "react";
import { Download, Loader2, X, ArrowRight } from "lucide-react";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export interface UpdateModalProps {
  open: boolean;
  version: string;
  currentVersion: string;
  notes?: string;
  onUpdate: () => Promise<void> | void;
  onDismiss: () => void;
  busy?: boolean;
  error?: string | null;
}

export function UpdateModal({
  open,
  version,
  currentVersion,
  notes,
  onUpdate,
  onDismiss,
  busy = false,
  error = null,
}: UpdateModalProps) {
  const { t } = useI18n();
  if (!open) return null;

  return (
    <div className="atlas-overlay atlas-center-overlay atlas-desktop-modal">
      <div
        aria-label={t("updates.modalTitle")} className="atlas-dialog atlas-update-dialog"
        role="dialog"
        aria-modal="true"
      >
        {/* Top Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-theme-accent-subtle bg-theme-subtle text-theme-accent shadow-inner">
              <Download className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground tracking-tight">
                {t("updates.modalTitle")}
              </h2>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-mono">v{currentVersion}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground/60" />
                <span className="font-mono font-medium text-theme-accent">v{version}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="rounded-full p-1 text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:opacity-50"
            title={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Release notes */}
        {notes && (
          <div className="mt-4 max-h-48 overflow-y-auto rounded-2xl border border-border bg-background/50 p-3.5 text-xs text-muted-foreground/90 font-mono leading-relaxed space-y-1">
            <p className="font-semibold text-foreground/90 font-sans uppercase tracking-wider text-[10px]">
              {t("updates.whatsNew")}
            </p>
            <div className="whitespace-pre-wrap">{notes}</div>
          </div>
        )}

        {/* Error message if any */}
        {error && (
          <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-950/40 p-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6 flex items-center justify-end gap-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            disabled={busy}
            className="rounded-xl px-4 text-xs text-muted-foreground hover:bg-white/5 hover:text-foreground"
          >
            {t("updates.later")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void onUpdate()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-xl bg-theme-accent px-5 text-xs font-semibold text-black hover:opacity-90 active:scale-95 shadow-theme-accent"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{t("updates.updating")}</span>
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5 stroke-[2.5]" />
                <span>{t("updates.updateNow")}</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
