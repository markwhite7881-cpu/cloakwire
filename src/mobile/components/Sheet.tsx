import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Bottom-sheet modal: dimmed backdrop + a panel pinned to the
 * bottom edge. Closes on backdrop tap and on the X button.
 * Rendered inline (no portal) — the mobile root is a fixed
 * full-height flex column, so `fixed inset-0` covers exactly it.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
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

  // Portal to <body>: a transformed ancestor (tab-enter animations,
  // future transitions) would otherwise turn the fixed overlay into
  // an inline block pinned inside the scrolling content.
  return createPortal(
    <div
      data-mobile-sheet=""
      className="atlas-overlay atlas-sheet-overlay"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="atlas-scrim"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="atlas-dialog atlas-sheet"
      >
        <div className="atlas-grip" aria-hidden="true"/>
        <div className="atlas-sheet-head">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sheet"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/5 active:text-foreground transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="atlas-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
