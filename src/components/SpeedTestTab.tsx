import { useEffect, useMemo, useRef, useState } from "react";
import { Gauge, Globe, ShieldCheck, Trash2, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { useI18n } from "@/lib/i18n";
import { SpeedTestRunner, loadSpeedTestHistory, clearSpeedTestHistory, type SpeedTestProgress, type SpeedTestResult } from "@/lib/speedtest";
import type { TrafficSample } from "@/lib/types";
import { TrafficGraph, type TrafficPoint } from "./TrafficGraph";

export function HomeTraffic({ samples, current, vpnActive, activeProfileName, androidRunId, testDisabled = false }: {
  samples: TrafficSample[]; current: TrafficSample | null; vpnActive: boolean; activeProfileName: string | null; androidRunId?: string | null; testDisabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const runner = useRef<SpeedTestRunner | null>(null);
  const [progress, setProgress] = useState<SpeedTestProgress | null>(null);
  const [testPoints, setTestPoints] = useState<TrafficPoint[]>([]);
  const [history, setHistory] = useState<SpeedTestResult[]>(loadSpeedTestHistory);
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState<SpeedTestResult|null>(null);
  function stop() {
    const previous = runner.current;
    runner.current = null;
    previous?.stop();
    setProgress(null);
  }
  useEffect(() => () => { const previous=runner.current; runner.current=null; previous?.stop(); }, []);
  async function start() {
    if (runner.current) return;
    const test = new SpeedTestRunner();
    runner.current = test;
    setProgress({phase:"ping",currentSpeed:0,progressPercent:0,pingMs:0,jitterMs:0,downloadMbps:0,uploadMbps:0,samples:[]});
    setError("");setTestPoints([]);setLastResult(null);
    try {
      const result = await test.run({vpnActive, androidRunId, serverName: vpnActive ? activeProfileName || t("speedtest.vpnActive") : t("speedtest.directRoute")}, p => {
        if (runner.current !== test) return;
        setProgress(p);
        // Phase announcements have no measurements. Upload's first announcement still holds the download speed.
        const download = p.phase === "download" && (p.samples.length > 0 || p.downloadMbps > 0);
        const upload = p.phase === "upload" && p.samples.length > 0;
        if (download || upload) {
          const point = { source: p, down: download ? p.currentSpeed : 0, up: upload ? p.currentSpeed : 0 };
          setTestPoints(previous => [...previous.slice(-59), point]);
        }
      });
      if (runner.current === test) { setLastResult(result);setHistory(loadSpeedTestHistory()); }
    } catch(err) {
      if (runner.current === test && !(err instanceof Error && err.name === "AbortError")) {
        const message = err instanceof Error ? err.message : t("common.error");
        setError(message === "speedtest_route_unavailable" ? t("speedtest.routeUnavailable") :
          message === "speedtest_request_failed" ? t("speedtest.requestFailed") : message);
      }
    } finally {
      if(runner.current === test) { runner.current=null;setProgress(null); }
    }
  }
  const livePoints = useMemo(() => samples.slice(-60).map(s => ({
    source: s, down: s.down_bps * 8 / 1e6, up: s.up_bps * 8 / 1e6,
  })), [samples]);
  const points = progress ? testPoints : livePoints;
  const rates = progress ? {
    down: progress.phase === "download" ? progress.currentSpeed : 0,
    up: progress.phase === "upload" && progress.samples.length > 0 ? progress.currentSpeed : 0,
  } : { down: (current?.down_bps ?? 0) * 8 / 1e6, up: (current?.up_bps ?? 0) * 8 / 1e6 };
  const fmt=(n:number)=>n.toLocaleString(locale,{maximumFractionDigits:1});
  const handleClearHistory=()=>{clearSpeedTestHistory();setHistory([]);setLastResult(null);};
  const phase = progress?.phase === "ping" ? "phasePing" : progress?.phase === "upload" ? "phaseUpload" : "phaseDownload";
  return <section className="atlas-panel atlas-traffic p-4 space-y-2">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{t(progress?"speedtest.title":"home.traffic")}</h2>
      <Button size="sm" variant="outline" disabled={!progress && testDisabled} onClick={progress?stop:start}><Gauge size={15}/>{t(progress ? "speedtest.stopTest" : androidRunId !== undefined && !vpnActive ? "speedtest.testDirect" : "nav.speedtest")}</Button>
    </div>
    <div className="flex flex-wrap gap-x-4 text-xs tabular-nums text-muted-foreground">
      <span>↓ {t("home.download")} {fmt(rates?.down??0)} Mbps</span><span>↑ {t("home.upload")} {fmt(rates?.up??0)} Mbps</span>
      {progress && <span>{t("speedtest."+phase)} · {Math.round(progress.progressPercent)}%</span>}
      {!progress && current && <span>{t("home.totalTraffic")} ↓ {fmt(current.down_total/1048576)} MiB · ↑ {fmt(current.up_total/1048576)} MiB</span>}
    </div>
    <TrafficGraph key={progress ? "test" : "live"} points={points} label={t(progress ? "speedtest.title" : "home.traffic")}/>
    {androidRunId !== undefined && !vpnActive && !testDisabled &&
      <p className="text-xs text-muted-foreground">{t("speedtest.directNotice")}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {lastResult && <p role="status" className="text-xs">{lastResult.serverName} · ↓ {fmt(lastResult.downloadSpeed)} / ↑ {fmt(lastResult.uploadSpeed)} Mbps · {lastResult.ping} ms</p>}
    <details><summary className="text-xs text-muted-foreground cursor-pointer">{t("speedtest.recentHistory")} · {history.length}</summary>
      {/* Recent Test History Card */}
      <Card className="atlas-history">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-theme-accent" />
              <CardTitle className="text-sm font-semibold">
                {t("speedtest.recentHistory")}
              </CardTitle>
            </div>
            {history.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearHistory}
              >
                <Trash2 className="h-3 w-3" />
                <span>{t("speedtest.clearHistory")}</span>
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              {t("speedtest.noHistory")}
            </p>
          ) : (
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/80">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-3 gap-2 text-xs hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    {item.vpnActive ? (
                      <ShieldCheck className="h-4 w-4 text-theme-accent shrink-0" />
                    ) : (
                      <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <div>
                      <p className="font-medium text-foreground">{item.serverName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(item.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}{" "}
                        · {new Date(item.timestamp).toLocaleDateString()}
                        {item.location ? ` · ${item.location}` : ""}
                      </p>
                      <p className="text-[11px] text-muted-foreground break-words">
                        {t("speedtest.jitter")} {fmt(item.jitter)} ms
                        {item.clientIp && ` · ${t("speedtest.clientIp")} ${item.clientIp}`}
                        {item.colo && ` · ${t("speedtest.colo")} ${item.colo}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-right tabular-nums">
                    <div>
                      <span className="text-[10px] text-muted-foreground block">Down</span>
                      <span className="font-semibold text-foreground">
                        {item.downloadSpeed.toFixed(1)} Mbps
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-muted-foreground block">Up</span>
                      <span className="font-semibold text-foreground">
                        {item.uploadSpeed.toFixed(1)} Mbps
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-muted-foreground block">Ping</span>
                      <span className="font-medium text-foreground">{item.ping} ms</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

    </details>
  </section>;
}
