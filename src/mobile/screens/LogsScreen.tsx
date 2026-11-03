import { AtlasHeading } from "@/components/atlas/AtlasHeading";
import { APP_VERSION } from "@/lib/appVersion";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, RefreshCw, Terminal } from "lucide-react";
import { vpnCoreVersion, vpnReadLogs } from "@/lib/vpn";
import { buildDiagnosticsReport, copyTextToClipboard } from "@/lib/diagnostics";
import { EmptyState } from "../components/EmptyState";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function LogsScreen({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!inTauri) {
      setText("preview mode - logs are available on Android builds");
      return;
    }
    setLoading(true);
    try {
      setText(await vpnReadLogs(300));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const copyReport = async () => {
    try {
      const coreVersion = inTauri ? await vpnCoreVersion().catch(() => null) : "preview";
      await copyTextToClipboard(buildDiagnosticsReport({
        platform: "android",
        appVersion: APP_VERSION,
        coreVersion,
        logLines: String(text).split("\n"),
      }));
      setCopied(true);
      setError(null);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [text]);

  const lines = text ? String(text).split("\n") : [];
  return (
    <div className="atlas-page atlas-log-page">
      <AtlasHeading title={t("nav.logs")} icon={Terminal} actions={<>
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to settings"
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-[var(--atlas-field)] text-foreground active:scale-95 transition"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => void copyReport()}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition active:scale-95",
              copied
                ? "border-theme-accent-subtle bg-theme-subtle text-theme-accent"
                : "border-border bg-[var(--atlas-field)] text-foreground",
            )}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-theme-accent" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("common.copied") : t("common.diagnostics")}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex h-8 items-center gap-1.5 rounded-xl border border-border bg-[var(--atlas-field)] px-3 text-xs text-foreground active:scale-95 transition disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin text-theme-accent")} />
            {t("common.refresh")}
          </button>
      </>}/>
      {error && <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2 text-xs text-destructive">{error}</p>}
      {lines.length === 0 ? (
        <EmptyState icon={Terminal} title={t("logs.emptyLogs")} hint={t("logs.emptyLogsHint")} />
      ) : (
        <div ref={scrollRef} className="atlas-console atlas-log-scroll">
          <pre className="atlas-mobile-log-lines">
            {lines.map((line, index) => (
              <div key={index} className={cn(/error|fatal|panic/i.test(line) && "text-destructive font-semibold", /warn/i.test(line) && "atlas-warning", /info/i.test(line) && "text-foreground/90")}>{line || " "}</div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
