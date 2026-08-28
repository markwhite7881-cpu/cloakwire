import { useEffect, useState } from "react";
import { Clipboard, Loader2, Plus } from "lucide-react";
import { Sheet } from "./Sheet";
import { api } from "@/lib/api";
import type { Outbound } from "@/lib/types";
import { cn } from "@/lib/utils";
import { classifySourceInput } from "../lib/mobileUi";
import { triggerHaptic } from "../lib/haptics";

const inputCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring";

export function AddSubscriptionSheet({
  open,
  onClose,
  onAdd,
  onAddLinks,
}: {
  open: boolean;
  onClose: () => void;
  // The parent (MobileApp → useSubscriptions.add) returns a Promise so
  // any error from the Rust `add_subscription` command reaches the
  // sheet's own error display instead of becoming an unhandled
  // promise rejection in the WebView. 2026-08-20.
  onAdd: (input: { name?: string; url: string }) => Promise<void>;
  onAddLinks: (outbounds: Outbound[]) => void;
}) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clipboardContent, setClipboardContent] = useState<string | null>(null);
  const sourceKind = classifySourceInput(source).kind;

  useEffect(() => {
    if (!open) {
      setClipboardContent(null);
      return;
    }
    let cancelled = false;
    const checkClipboard = async () => {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
          const text = await navigator.clipboard.readText();
          if (cancelled || !text) return;
          const trimmed = text.trim();
          const isVpnLink = /^(vless|vmess|ss|trojan|tuic|hy2|hysteria2|http|https):\/\//i.test(trimmed);
          if (isVpnLink && trimmed !== source.trim()) {
            setClipboardContent(trimmed);
          }
        }
      } catch {
        // Ignored if browser / OS restricts background clipboard read
      }
    };
    void checkClipboard();
    return () => {
      cancelled = true;
    };
  }, [open, source]);

  const pasteFromClipboard = async () => {
    try {
      triggerHaptic("light");
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
        const text = await navigator.clipboard.readText();
        if (text) {
          setSource((prev) => (prev.trim() ? `${prev.trim()}\n${text.trim()}` : text.trim()));
          setClipboardContent(null);
        }
      }
    } catch {
      // Ignored
    }
  };

  const reset = () => {
    setSource("");
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    const input = source.trim();
    if (!input) {
      setError("Paste a subscription URL or share link.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.parseInput(source);
      if (result.outbounds.length === 0 && result.subscriptions.length === 0) {
        setError(
          result.failures[0]
            ? String(result.failures[0].error)
            : "Unsupported link or subscription URL.",
        );
        setBusy(false);
        return;
      }

      if (result.outbounds.length > 0) onAddLinks(result.outbounds);
      // Await each subscription add so a Rust error (e.g. network
      // failure, classification error) surfaces here as a visible
      // error pill instead of an unhandled promise rejection. 2026-08-20.
      // The HWID is **device-wide** (configured in Settings), not
      // per-subscription — see SettingsScreen for the override UI.
      for (const url of result.subscriptions) {
        await onAdd({ url });
      }

      reset();
      onClose();
    } catch (e) {
      // Accept Error, TauriCommandError, or a raw `{kind, message}`
      // object thrown by `invoke` (the latter would render as the
      // literal string `[object Object]` otherwise). 2026-08-20.
      let msg: string;
      if (e instanceof Error) {
        msg = e.message || e.name || String(e);
      } else if (
        e &&
        typeof e === "object" &&
        typeof (e as { message?: unknown }).message === "string"
      ) {
        msg = (e as { message: string }).message;
      } else {
        msg = String(e);
      }
      setError(msg);
      setBusy(false);
    }
  };

  const sourceHint =
    sourceKind === "share"
      ? "Share link detected. Additional lines are parsed too."
      : sourceKind === "subscription"
        ? "Subscription URL detected. Additional lines are parsed too."
        : "Paste one or more links. Each non-empty line will be parsed.";

  return (
    <Sheet open={open} onClose={onClose} title="Add servers & subscriptions">
      <div className="space-y-4">
        {clipboardContent && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-3 shadow-sm animate-in fade-in slide-in-from-top-1">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                <Clipboard className="h-3 w-3" />
                <span>Link in clipboard</span>
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {clipboardContent}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void pasteFromClipboard()}
              className="shrink-0 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 shadow transition active:scale-95 hover:bg-emerald-400"
            >
              Paste
            </button>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="block text-xs font-mono uppercase tracking-wider text-muted-foreground" htmlFor="server-source">
              Share Link or Subscription URL
            </label>
            <button
              type="button"
              onClick={() => void pasteFromClipboard()}
              className="flex items-center gap-1 font-mono text-[11px] text-emerald-400 hover:underline active:opacity-80"
            >
              <Clipboard className="h-3 w-3" />
              <span>Paste from clipboard</span>
            </button>
          </div>
          <textarea
            id="server-source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setError(null);
            }}
            placeholder={"https://provider.example/sub\nvless://uuid@host:port?type=tcp...\nhy2://pass@host:port..."}
            rows={5}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-h-[120px] w-full resize-none rounded-xl border border-border/80 bg-[#07080c] px-3.5 py-2.5 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/40 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground/80">{sourceHint}</p>
        </div>

        {error && <p className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">{error}</p>}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || source.trim().length === 0}
          className={cn(
            "flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold",
            "bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20 active:scale-[0.98] transition",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4 stroke-[2.5]" />
          )}
          Import
        </button>
      </div>
    </Sheet>
  );
}
