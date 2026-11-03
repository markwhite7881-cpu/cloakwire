import { Button } from "@/components/Button";
import { humanError } from "@/lib/profileCheck";
import { useEffect, useState } from "react";
import { Clipboard, Loader2, Plus } from "lucide-react";
import { Sheet } from "./Sheet";
import { api } from "@/lib/api";
import { vpnReadClipboard } from "@/lib/vpn";
import type { Outbound } from "@/lib/types";
import { cn } from "@/lib/utils";
import { classifySourceInput } from "../lib/mobileUi";
import { triggerHaptic } from "../lib/haptics";
import { useI18n } from "@/lib/i18n";

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
  onAddLinks: (outbounds: Outbound[]) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clipboardContent, setClipboardContent] = useState<string | null>(null);
  const sourceKind = classifySourceInput(source).kind;

  const readClipboardText = async (): Promise<string> => {
    try {
      const native = await vpnReadClipboard();
      if (native) return native;
    } catch {
      // ignore
    }
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.readText === "function"
      ) {
        return (await navigator.clipboard.readText()) || "";
      }
    } catch {
      // ignore
    }
    return "";
  };

  useEffect(() => {
    if (!open) {
      setClipboardContent(null);
      return;
    }
    let cancelled = false;
    const checkClipboard = async () => {
      try {
        const text = await readClipboardText();
        if (cancelled || !text) return;
        const trimmed = text.trim();
        const isVpnLink = /^(vless|vmess|ss|trojan|tuic|hy2|hysteria2|http|https):\/\//i.test(trimmed);
        if (isVpnLink && trimmed !== source.trim()) {
          setClipboardContent(trimmed);
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
      const text = await readClipboardText();
      if (text) {
        setSource((prev) => (prev.trim() ? `${prev.trim()}\n${text.trim()}` : text.trim()));
        setClipboardContent(null);
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
      setError(t("servers.pasteShareOrSubUrl"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.parseInput(source);
      if (result.outbounds.length === 0 && result.subscriptions.length === 0) {
        setError(
          result.failures[0]
            ? humanError(result.failures[0].error)
            : t("servers.unsupportedLinkOrUrl"),
        );
        setBusy(false);
        return;
      }

      if (result.outbounds.length > 0 && !await onAddLinks(result.outbounds)) { setBusy(false); return; }
      // Await each subscription add so a Rust error (e.g. network
      // failure, classification error) surfaces here as a visible
      // error pill instead of an unhandled promise rejection. 2026-08-20.
      // The HWID is **device-wide** (configured in Settings), not
      // per-subscription — see SettingsScreen for the override UI.
      for (const url of result.subscriptions) {
        await onAdd({ url });
      }

      if (result.failures.length) { setError(t("profileImport.partial")); setBusy(false); return; }
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
      ? t("servers.shareLinkDetected")
      : sourceKind === "subscription"
        ? t("servers.subUrlDetected")
        : t("servers.pasteLinksHint");

  return (
    <Sheet open={open} onClose={onClose} title={t("atlas.importSources")}>
      <div className="space-y-4">
        {clipboardContent && (
          <div className="atlas-source-preview">
            <div className="min-w-0 flex-1">
              <div className="atlas-field-caption inline-flex items-center gap-1.5">
                <Clipboard className="h-3 w-3" />
                <span>{t("servers.linkInClipboard")}</span>
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {clipboardContent}
              </p>
            </div>
            <Button size="sm" variant="outline"
              type="button"
              onClick={() => void pasteFromClipboard()}
            >
              {t("common.paste")}
            </Button>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="atlas-field-caption" htmlFor="server-source">
              {t("servers.subscriptionUrl")}
            </label>
            <Button size="sm" variant="ghost"
              type="button"
              onClick={() => void pasteFromClipboard()}
            >
              <Clipboard className="h-3 w-3" />
              <span>{t("common.pasteFromClipboard")}</span>
            </Button>
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
            className="atlas-input min-h-[120px] w-full resize-none font-mono"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground/80">{sourceHint}</p>
        </div>

        {error && <p className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">{error}</p>}
        <Button size="default" variant="default"
          type="button"
          onClick={() => void submit()}
          disabled={busy || source.trim().length === 0}
          className="w-full"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4 stroke-[2.5]" />
          )}
          {t("common.add")}
        </Button>
      </div>
    </Sheet>
  );
}
