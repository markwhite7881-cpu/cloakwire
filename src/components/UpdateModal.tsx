import { useState } from "react";
import { Download, Loader2, Sparkles, X, ArrowRight } from "lucide-react";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { cn } from "@/lib/utils";

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
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-[#0c0d14] p-6 shadow-2xl ring-1 ring-white/10"
        role="dialog"
        aria-modal="true"
      >
        {/* Glow effect */}
        <div className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-brand/15 blur-3xl" />
        <div className="pointer-events-none absolute -left-12 -bottom-12 h-36 w-36 rounded-full bg-cyan-500/10 blur-3xl" />

        {/* Top Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-theme-accent-subtle bg-theme-subtle text-theme-accent shadow-inner">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground tracking-tight">
                Доступно обновление
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
            title="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Release notes */}
        {notes && (
          <div className="mt-4 max-h-48 overflow-y-auto rounded-2xl border border-white/5 bg-background/50 p-3.5 text-xs text-muted-foreground/90 font-mono leading-relaxed space-y-1">
            <p className="font-semibold text-foreground/90 font-sans uppercase tracking-wider text-[10px]">
              Что нового:
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
            Позже
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
                <span>Обновление…</span>
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5 stroke-[2.5]" />
                <span>Обновить</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
