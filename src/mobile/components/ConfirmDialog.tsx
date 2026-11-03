import { Button } from "@/components/Button";
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
    <div data-mobile-sheet="" className="atlas-overlay atlas-center-overlay">
      <button
        type="button"
        aria-label={cancelLabel}
        onClick={onClose}
        className="atlas-scrim"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title} className="atlas-dialog atlas-confirm"
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
          <Button size="sm" variant="outline"
            type="button"
            onClick={onClose}
          >
            {cancelLabel}
          </Button>
          <Button size="sm" variant={destructive ? "destructive" : "default"}
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
