import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Check, Copy, Terminal } from "lucide-react";
import { LogView } from "./LogView";
import { Button } from "./Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./Card";
import { buildDiagnosticsReport, copyTextToClipboard } from "@/lib/diagnostics";
import type { LogLine } from "@/lib/types";

export function LogsTab({ logs, onClear }: { logs: LogLine[]; onClear: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("unknown");

  useEffect(() => {
    let active = true;
    void getVersion()
      .then((version) => {
        if (active) setAppVersion(version);
      })
      .catch(() => {
        if (active) setAppVersion("unknown");
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
      <Card className="bento-card">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-emerald-400" />
                Live Console & Diagnostics
              </CardTitle>
              <CardDescription>
                Diagnostic copies include only the latest 200 lines and redact URLs, UUIDs, IP addresses, emails, and long tokens.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void copyReport()}>
              {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy diagnostics"}
            </Button>
          </div>
          {copyError && <p className="text-xs text-destructive">{copyError}</p>}
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <LogView logs={logs} className="h-[60vh]" onClear={onClear} />
        </CardContent>
      </Card>
    </div>
  );
}
