import { useEffect, useRef, useState } from "react";
import { Gauge, Globe, ShieldCheck, Trash2, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { useI18n } from "@/lib/i18n";
import { SpeedTestRunner, loadSpeedTestHistory, clearSpeedTestHistory, type SpeedTestProgress, type SpeedTestResult } from "@/lib/speedtest";
import type { TrafficSample } from "@/lib/types";

type Point = { down: number; up: number };
export function HomeTraffic({ samples, current, vpnActive, activeProfileName }: {
  samples: TrafficSample[]; current: TrafficSample | null; vpnActive: boolean; activeProfileName: string | null;
}) {
  const { t, locale } = useI18n();
  const runner = useRef<SpeedTestRunner | null>(null);
  const [progress, setProgress] = useState<SpeedTestProgress | null>(null);
  const [testPoints, setTestPoints] = useState<Point[]>([]);
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
      const result = await test.run({vpnActive, serverName:activeProfileName || (vpnActive ? t("speedtest.vpnActive") : t("speedtest.directRoute"))}, p => {
        if (runner.current !== test) return;
        setProgress(p);
        if (p.phase === "download" || p.phase === "upload") setTestPoints(previous => [...previous.slice(-59), {
        down:p.phase === "download" ? p.currentSpeed : 0, up:p.phase === "upload" ? p.currentSpeed : 0
        }]);
      });
      if (runner.current === test) { setLastResult(result);setHistory(loadSpeedTestHistory()); }
    } catch(err) {
      if(runner.current === test && !(err instanceof Error && err.name === "AbortError")) setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      if(runner.current === test) { runner.current=null;setProgress(null); }
    }
  }
  const points = progress ? testPoints : samples.slice(-60).map(s=>({down:s.down_bps * 8 / 1e6, up:s.up_bps * 8 / 1e6}));
  const rates = progress ? points.at(-1) : {down:(current?.down_bps ?? 0)*8/1e6,up:(current?.up_bps ?? 0)*8/1e6};
  const scale = Math.max(.1,...points.flatMap(p=>[p.up,p.down]));
  const line=(series:keyof Point)=>points.map((p,i)=>[(60-points.length+i)*1000/59,68-62*p[series]/scale].join(",")).join(" ");
  const fmt=(n:number)=>n.toLocaleString(locale,{maximumFractionDigits:1});
  const handleClearHistory=()=>{clearSpeedTestHistory();setHistory([]);setLastResult(null);};
  const phase = progress?.phase === "ping" ? "phasePing" : progress?.phase === "upload" ? "phaseUpload" : "phaseDownload";
  return <section className="atlas-traffic bento-card rounded-xl p-4 space-y-2">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{t(progress?"speedtest.title":"home.traffic")}</h2>
      <Button size="sm" variant="outline" onClick={progress?stop:start}><Gauge size={15}/>{t(progress?"speedtest.stopTest":"nav.speedtest")}</Button>
    </div>
    <div className="flex flex-wrap gap-x-4 text-xs tabular-nums text-muted-foreground">
      <span>↓ {t("home.download")} {fmt(rates?.down??0)} Mbps</span><span>↑ {t("home.upload")} {fmt(rates?.up??0)} Mbps</span>
      {progress && <span>{t("speedtest."+phase)} · {Math.round(progress.progressPercent)}%</span>}
      {!progress && current && <span>{t("home.totalTraffic")} ↓ {fmt(current.down_total/1048576)} MiB · ↑ {fmt(current.up_total/1048576)} MiB</span>}
    </div>
    <svg viewBox="0 0 1000 72" preserveAspectRatio="none" role="img" aria-label={t(progress?"speedtest.title":"home.traffic")}>
      {[6,37,68].map(y=><line key={y} x1="0" x2="1000" y1={y} y2={y} stroke="var(--atlas-line)"/>)}
      <polyline points={line("down")} fill="none" stroke="var(--accent-badge-text)" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
      <polyline points={line("up")} fill="none" stroke="currentColor" opacity=".7" strokeDasharray="4 3" strokeWidth="1.6" vectorEffect="non-scaling-stroke"/>
    </svg>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {lastResult && <p role="status" className="text-xs">{lastResult.serverName} · ↓ {fmt(lastResult.downloadSpeed)} / ↑ {fmt(lastResult.uploadSpeed)} Mbps · {lastResult.ping} ms</p>}
    <details><summary className="text-xs text-muted-foreground cursor-pointer">{t("speedtest.recentHistory")} · {history.length}</summary>
      {/* Recent Test History Card */}
      <Card className="bento-card">
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
                className="h-7 text-xs text-muted-foreground hover:text-destructive gap-1 px-2"
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
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-right tabular-nums">
                    <div>
                      <span className="text-[10px] uppercase text-muted-foreground block">Down</span>
                      <span className="font-semibold text-emerald-400">
                        {item.downloadSpeed.toFixed(1)} Mbps
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-muted-foreground block">Up</span>
                      <span className="font-semibold text-blue-400">
                        {item.uploadSpeed.toFixed(1)} Mbps
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-muted-foreground block">Ping</span>
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
