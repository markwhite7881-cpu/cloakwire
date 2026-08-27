import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, RefreshCw, Terminal } from "lucide-react";
import { vpnCoreVersion, vpnReadLogs } from "@/lib/vpn";
import { buildDiagnosticsReport, copyTextToClipboard } from "@/lib/diagnostics";
import { EmptyState } from "../components/EmptyState";
import { cn } from "@/lib/utils";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function LogsScreen({ onBack }: { onBack: () => void }) {
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
        appVersion: "1.3.1",
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
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} aria-label="Back to settings" className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground active:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="text-base font-semibold tracking-tight">Logs</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => void copyReport()} className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground active:bg-accent">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Diagnostics"}
          </button>
          <button type="button" onClick={() => void refresh()} disabled={loading} className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground active:bg-accent disabled:opacity-50">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>
      {error && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
      {lines.length === 0 ? (
        <EmptyState icon={Terminal} title="No log lines" hint="The core writes here once the VPN has started." />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card p-3">
          <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-foreground/80">
            {lines.map((line, index) => (
              <div key={index} className={cn(/error|fatal|panic/i.test(line) && "text-destructive", /warn/i.test(line) && "text-amber-300")}>{line || " "}</div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
