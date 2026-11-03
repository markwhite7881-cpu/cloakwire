import { AtlasHeading } from "@/components/atlas/AtlasHeading";
import { APP_VERSION } from "@/lib/appVersion";
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Check, Copy, Terminal } from "lucide-react";
import { LogView } from "./LogView";
import { Button } from "./Button";
import { buildDiagnosticsReport, copyTextToClipboard } from "@/lib/diagnostics";
import { useI18n } from "@/lib/i18n";
import type { LogLine } from "@/lib/types";

export function LogsTab({ logs, onClear }: { logs: LogLine[]; onClear: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState(APP_VERSION);

  useEffect(() => {
    let active = true;
    void getVersion()
      .then((version) => {
        if (active) setAppVersion(version);
      })
      .catch(() => {
        if (active) setAppVersion(APP_VERSION);
      });
    return () => {
      active = false;
    };
  }, []);

  const copyReport = async () => {
    const report = buildDiagnosticsReport({
      platform: navigator.platform || "desktop",
      appVersion,
      logLines: logs.map((entry) => `${entry.ts} ${entry.stream} ${entry.line}`),
    });
    try {
      await copyTextToClipboard(report);
      setCopied(true);
      setCopyError(null);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="atlas-page atlas-log-page">
      <AtlasHeading title={t("logs.title")} icon={Terminal} description={t("logs.subtitle")} actions={
            <Button variant="outline" size="sm" onClick={() => void copyReport()}>
              {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
      }/>
      {copyError && <p role="alert" className="text-xs text-destructive">{copyError}</p>}
      <LogView logs={logs} className="atlas-console" onClear={onClear}/>
    </div>
  );
}
