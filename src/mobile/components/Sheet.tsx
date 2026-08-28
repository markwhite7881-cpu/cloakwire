import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

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
      className="fixed inset-0 z-50 flex items-end justify-center animate-in fade-in duration-200"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative w-full max-w-lg rounded-t-3xl border border-b-0 border-white/10 bg-[#0c0d14]",
          "max-h-[88vh] overflow-y-auto shadow-2xl backdrop-blur-2xl ring-1 ring-white/5",
          "pb-[env(safe-area-inset-bottom)]",
        )}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-white/20" />
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-[#0c0d14]/95 px-5 py-3.5 backdrop-blur-xl">
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
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
