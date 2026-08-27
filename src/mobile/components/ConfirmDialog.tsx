import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Centered confirmation popup, portaled to <body> like the Sheet (a
 * transformed ancestor would otherwise trap the fixed overlay).
 * Destructive by default — used for deletions.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div data-mobile-sheet="" className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label={cancelLabel}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        className="relative w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
              destructive
                ? "bg-destructive/15 text-destructive"
                : "bg-primary/15 text-primary",
            )}
          >
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {description && (
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm text-foreground active:bg-accent"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              "h-9 rounded-md px-3 text-sm font-medium text-white",
              destructive
                ? "bg-destructive active:bg-destructive/90"
                : "bg-primary active:bg-primary/90",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
