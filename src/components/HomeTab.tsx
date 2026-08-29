import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  Link2,
  Loader2,
  Plus,
  Power,
  Server,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { Button } from "@/components/Button";
import { Card, CardContent } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { FlagIcon } from "@/components/FlagIcon";
import { useTrafficStream } from "@/hooks/useTrafficStream";
import { latencyToBars, useServerLatency } from "@/hooks/useServerLatency";
import { cn } from "@/lib/utils";
import { flagForProfile } from "@/lib/flags";
import { profileLabel, profileEndpoint, isSupported } from "@/lib/outbound";
import { isValidProfileSelection } from "@/lib/profileSelection";
import type { HomeProfileMetadata, Outbound, RoutingOptions, Status, StatusReport, TrafficSample } from "@/lib/types";
import type { ConnectionProfile } from "@/lib/connectionProfiles";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface HomeTabProps {
  status: StatusReport;
  statusLabel: Status;
  busy: boolean;
  error: string | null;
  canStart: boolean;
  configName: string | null;
  profiles: ConnectionProfile[];
  selectedIndex: number;
  /**
   * Tag of the outbound the running `proxy` selector is currently
   * routing through, as reported by the clash API. `null` while
   * sing-box is stopped or while we haven't polled yet.
   * "auto" means the `auto` urltest is in control.
   */
  activeOutbound: string | null;
  /** Safe country and latency metadata for ready Xray profiles, keyed by `${subscriptionId}:${key}`. */
  readyProfileMetadata: ReadonlyMap<string, HomeProfileMetadata>;
  /** Safe subscription summary names keyed by subscription ID. */
  subscriptionNames: ReadonlyMap<string, string>;
  /** ip → country-code map, populated by the useGeoIp hook. */
  geoipByIp: Record<string, string>;
  subscriptionOutbounds?: Record<string, { outbounds: Outbound[] }>;
  onSelect: (index: number) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  routingOptions?: RoutingOptions;
  onNavigateTab?: (tab: string) => void;
  onAddLinks?: (text: string) => void;
}

export function HomeTab({
  status,
  statusLabel,
  busy,
  error,
  canStart,
  configName: _configName,
  profiles,
  selectedIndex,
  activeOutbound,
  readyProfileMetadata,
  subscriptionNames,
  geoipByIp,
  subscriptionOutbounds,
  onSelect,
  onConnect,
  onDisconnect,
  routingOptions,
  onNavigateTab,
  onAddLinks,
}: HomeTabProps) {
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddText, setQuickAddText] = useState("");

  const isRunning = statusLabel === "running";
  const isTransition = statusLabel === "starting" || statusLabel === "stopping";
  const trafficLive = useTrafficStream(isRunning || !inTauri, profiles.length);
  const current = trafficLive.current;

  // Probe latency for both manual profiles and hydrated subscription outbounds.
  const allOutbounds = useMemo(() => {
    const manual = profiles
      .filter((profile): profile is Extract<ConnectionProfile, { kind: "manual" }> => profile.kind === "manual")
      .map((profile) => profile.outbound);
    const subOutbounds = subscriptionOutbounds
      ? Object.values(subscriptionOutbounds).flatMap((r) => r.outbounds)
      : [];
    return [...manual, ...subOutbounds];
  }, [profiles, subscriptionOutbounds]);

  const latency = useServerLatency(allOutbounds, isRunning);

  const headline = (() => {
    if (statusLabel === "running") return "Connected";
    if (statusLabel === "starting") return "Connecting…";
    if (statusLabel === "stopping") return "Disconnecting…";
    if (statusLabel === "crashed") return "Crashed";
    return "Disconnected";
  })();

  // Clamp the selected index whenever the list shrinks so we never
  // point at a missing server.
  useEffect(() => {
    if (profiles.length === 0 && selectedIndex !== -1) onSelect(-1);
    else if (profiles.length > 0 && !isValidProfileSelection(selectedIndex, profiles.length))
      onSelect(0);
  }, [profiles.length, selectedIndex, onSelect]);

  const selected = profiles[selectedIndex];
  const isXrayRunning = isRunning && status.engine === "xray";
  const activeXrayProfile = isXrayRunning
    ? profiles.find(
        (profile): profile is Extract<ConnectionProfile, { kind: "ready_config" }> =>
          profile.kind === "ready_config" &&
          profile.engine === "xray" &&
          profile.key === status.profile_key,
      )
    : undefined;
  const activeXrayDisplay = activeXrayProfile
    ? connectionProfileDisplay(activeXrayProfile, readyProfileMetadata, geoipByIp, latency.byTag)
    : { flag: "🌐", code: "??", label: status.profile_name ?? "Xray", ms: undefined };

  const activeIsAuto = activeOutbound === "auto";
  const activeProfile = activeOutbound
    ? profiles.find((profile) => {
        if (profile.kind === "manual" && isSupported(profile.outbound)) {
          return profile.outbound.tag === activeOutbound;
        }
        if (profile.kind === "subscription") {
          return profile.label === activeOutbound;
        }
        return false;
      })
    : undefined;

  const activeFlag = activeIsAuto
    ? { flag: "🌐", code: "??" }
    : activeOutbound
      ? flagForProfile({
          tag: activeOutbound,
          geoipByIp,
        })
      : null;
  const activeName = activeIsAuto
    ? "Auto (urltest)"
    : activeOutbound ?? null;

  const selectedTag = selected?.kind === "manual" && isSupported(selected.outbound)
    ? selected.outbound.tag
    : selected?.kind === "subscription"
      ? selected.label
      : null;
  const activeMatchesPicked =
    activeOutbound == null ||
    (selectedIndex >= 0 && selectedTag === activeOutbound);
  const userPicked = !activeMatchesPicked
    ? selectedIndex === -1
      ? "Auto"
      : selected
        ? connectionProfileLabel(selected)
        : null
    : null;

  const vpnProcesses = routingOptions?.vpn_processes ?? [];
  const directProcesses = routingOptions?.direct_processes ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
      
      {/* ─── Bento Grid: 12-Column Layout ────────────────────────── */}
      <div className="grid grid-cols-12 gap-5">
        
        {/* Bento 1: Primary Hero Connect Card (7 cols on desktop) */}
        <div className="col-span-7 bento-card rounded-2xl p-6 sm:p-7 flex flex-col justify-between relative z-20 group">
          <div className="absolute inset-0 overflow-hidden rounded-2xl pointer-events-none">
            <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-emerald-500/10 blur-3xl" />
          </div>

          {/* Top Info inside Hero */}
          <div className="relative z-30 flex w-full items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                Active Tunnel
              </div>
              <ServerPicker
                profiles={profiles}
                selectedIndex={selectedIndex}
                latencyByTag={latency.byTag}
                readyProfileMetadata={readyProfileMetadata}
                subscriptionNames={subscriptionNames}
                geoipByIp={geoipByIp}
                onSelect={onSelect}
              />
            </div>

            <span className="rounded-lg border border-border/80 bg-background/60 px-2.5 py-1 font-mono text-[11px] text-muted-foreground shadow-sm">
              {isXrayRunning
                ? "Xray Core"
                : activeProfile?.kind === "manual" && isSupported(activeProfile.outbound)
                  ? `${activeProfile.outbound.protocol.toUpperCase()} ${"tls" in activeProfile.outbound && activeProfile.outbound.tls?.reality ? "• Reality" : ""}`
                  : activeProfile?.kind === "subscription"
                    ? activeProfile.protocol.toUpperCase()
                    : "sing-box"}
            </span>
          </div>

          {/* Center Tactile Power Orb */}
          <div className="relative z-10 my-8 flex flex-col items-center justify-center text-center">
            <div className="relative flex items-center justify-center">
              {isRunning && (
                <div className="absolute h-28 w-28 rounded-full bg-emerald-500/25 animate-ping opacity-40 pointer-events-none" />
              )}
              <button
                type="button"
                onClick={isRunning ? onDisconnect : onConnect}
                disabled={busy || isTransition || (!isRunning && !canStart)}
                aria-label={isRunning ? "Disconnect" : "Connect"}
                className={cn(
                  "group relative flex h-24 w-24 items-center justify-center rounded-full",
                  "border-2 transition-all duration-300",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
                  "disabled:cursor-not-allowed",
                  powerButtonClasses(statusLabel),
                )}
              >
                {isTransition ? (
                  <Loader2 className="h-9 w-9 animate-spin text-foreground/80" />
                ) : (
                  <Power
                    className={cn(
                      "h-10 w-10 transition-transform duration-200 group-hover:scale-110",
                      isRunning ? "text-zinc-950 stroke-[2.5]" : "text-muted-foreground",
                    )}
                  />
                )}
              </button>
            </div>

            <div className="mt-4 space-y-1">
              <div className="flex items-center justify-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-foreground">{headline}</h1>
                {isRunning && (
                  <Badge variant="default" className="bg-emerald-950/80 text-emerald-400 border border-emerald-800/60 text-[10px]">
                    <Sparkles className="h-3 w-3 mr-1" />
                    live
                  </Badge>
                )}
              </div>
              <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                {isRunning
                  ? isXrayRunning
                    ? <>
                        <span>via</span>
                        <FlagIcon code={activeXrayDisplay.code} size={14} className="self-center" />
                        <span className="font-medium text-foreground">{status.profile_name ?? activeXrayDisplay.label}</span>
                      </>
                    : activeName && activeFlag
                      ? <>
                          <span>via</span>
                          <FlagIcon code={activeFlag.code} size={14} className="self-center" />
                          <span className="font-medium text-foreground">{activeName}</span>
                        </>
                      : "sing-box is running."
                  : profiles.length === 0
                    ? "Add a server in the Servers tab to get started."
                    : "Click the button to bring the tunnel up."}
              </p>
              {isRunning && !isXrayRunning && userPicked && (
                <p className="font-mono text-[10px] text-muted-foreground/70">
                  picked: {userPicked}
                </p>
              )}
            </div>
          </div>

          {/* Bottom of Hero */}
          <div className="relative z-10 border-t border-border/60 pt-3 flex items-center justify-between text-[11px] font-mono text-muted-foreground/70">
            <span>TUN Mode • Protected</span>
            <span>{isXrayRunning ? "Xray Core" : "sing-box Core"}</span>
          </div>
        </div>

        {/* Right Column (5 cols on desktop): Live Traffic & Per-App Routing */}
        <div className="col-span-5 flex flex-col gap-5">
          
          {/* Bento 2: Live Traffic */}
          <div className="bento-card rounded-2xl p-5 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                Live Traffic
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {isRunning ? (status.engine ? `${status.engine} engine` : "sing-box") : "idle"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-2">
              <div className="rounded-xl border border-border/60 bg-background/50 p-3 shadow-sm">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                  <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />
                  Download
                </div>
                <p className="mt-1 font-mono text-xl font-bold tabular-nums text-foreground">
                  {formatRate(current?.down_bps ?? 0)}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  total {formatBytes(current?.down_total ?? 0)}
                </p>
              </div>

              <div className="rounded-xl border border-border/60 bg-background/50 p-3 shadow-sm">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                  <TrendingUp className="h-3.5 w-3.5 text-cyan-500" />
                  Upload
                </div>
                <p className="mt-1 font-mono text-xl font-bold tabular-nums text-foreground">
                  {formatRate(current?.up_bps ?? 0)}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  total {formatBytes(current?.up_total ?? 0)}
                </p>
              </div>
            </div>

            {/* Dynamic Non-Clipping Sensitive SVG Sparkline */}
            <SparklineWave isRunning={isRunning} samples={trafficLive.samples} current={current} />
          </div>

          {/* Bento 3: Per-App Split Tunneling Snapshot */}
          <div className="bento-card rounded-2xl p-5 flex flex-col justify-between flex-1">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                Per-App Routing
              </span>
              <button
                type="button"
                onClick={() => onNavigateTab?.("routing")}
                className="text-xs text-emerald-400 hover:underline cursor-pointer flex items-center gap-1 font-medium"
              >
                Manage ({vpnProcesses.length + directProcesses.length} active) ↗
              </button>
            </div>

            {vpnProcesses.length === 0 && directProcesses.length === 0 ? (
              <div className="text-xs text-muted-foreground/80 py-1">
                All applications route through VPN by default. Click manage to customize split tunneling.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 pt-0.5">
                {vpnProcesses.slice(0, 4).map((app: string) => (
                  <div key={app} className="flex items-center gap-1.5 bg-background/70 border border-emerald-500/30 px-2.5 py-1 rounded-lg text-xs">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span className="font-mono text-foreground text-[11px]">{app}</span>
                    <span className="text-[10px] text-emerald-400 font-mono">VPN</span>
                  </div>
                ))}
                {directProcesses.slice(0, 2).map((app: string) => (
                  <div key={app} className="flex items-center gap-1.5 bg-background/50 border border-border/80 px-2.5 py-1 rounded-lg text-xs text-muted-foreground">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                    <span className="font-mono text-[11px]">{app}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">Direct</span>
                  </div>
                ))}
                {vpnProcesses.length + directProcesses.length > 6 && (
                  <span className="text-[10px] font-mono text-muted-foreground self-center">
                    +{vpnProcesses.length + directProcesses.length - 6} more
                  </span>
                )}
              </div>
            )}
          </div>

        </div>

      </div>

      {error && (
        <Card className="border-destructive/30 bg-destructive/10">
          <CardContent className="flex items-start gap-2 p-3 text-xs text-destructive">
            <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{error}</span>
          </CardContent>
        </Card>
      )}

      {/* All-servers strip — quick visual switcher. */}
      {profiles.length > 0 && (
        <Card className="bento-card p-4">
          <div className="mb-3 flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              <Server className="h-3.5 w-3.5 text-emerald-400" />
              All Servers ({profiles.length})
            </div>
            <button
              type="button"
              onClick={() => setQuickAddOpen(true)}
              className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-950/60 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-900/60 transition shadow-sm"
              title="Add Server or Subscription"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add</span>
            </button>
          </div>
          <GroupedHomeProfileRows
            profiles={profiles}
            selectedIndex={selectedIndex}
            readyProfileMetadata={readyProfileMetadata}
            subscriptionNames={subscriptionNames}
            geoipByIp={geoipByIp}
            latencyByTag={latency.byTag}
            onSelect={onSelect}
            mode="grid"
          />
        </Card>
      )}

      {/* Quick Add Modal */}
      {quickAddOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200"
          onClick={() => setQuickAddOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-border/90 bg-[#0c0d14] p-6 shadow-2xl space-y-4 ring-1 ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/50 p-2 text-emerald-400">
                  <Link2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    Add Server or Subscription
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Paste share links or subscription URLs (one per line)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setQuickAddOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <textarea
              value={quickAddText}
              onChange={(e) => setQuickAddText(e.target.value)}
              placeholder={
                "vless://uuid@host:port?type=tcp&security=reality&pbk=...\n" +
                "https://provider.example.com/sub?token=ABCD-1234"
              }
              className="min-h-[120px] w-full resize-y rounded-xl border border-border/80 bg-[#07080c] px-3.5 py-2.5 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/40 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
              spellCheck={false}
              autoFocus
            />

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setQuickAddOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!quickAddText.trim()}
                onClick={() => {
                  if (quickAddText.trim()) {
                    onAddLinks?.(quickAddText.trim());
                    setQuickAddText("");
                    setQuickAddOpen(false);
                  }
                }}
                className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium px-4"
              >
                Import
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SparklineWave({
  isRunning,
  samples,
  current,
}: {
  isRunning: boolean;
  samples: TrafficSample[];
  current: TrafficSample | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Keep target samples in a ref so the animation loop always accesses the latest data
  const dataRef = useRef({
    samples,
    current,
    isRunning,
  });
  dataRef.current = { samples, current, isRunning };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const pointCount = 28;
    const currentDown = new Float32Array(pointCount);
    const currentUp = new Float32Array(pointCount);
    let smoothedPeak = 1024 * 32;

    const startTime = performance.now();

    const render = (now: number) => {
      const { samples: liveSamples, current: liveCurrent, isRunning: active } = dataRef.current;
      const elapsed = (now - startTime) / 1000;

      // Handle high-DPI crisp canvas rendering
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 240;
      const height = canvas.clientHeight || 54;
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const bottomY = height - 6;
      const topY = 6;
      const usableHeight = bottomY - topY;

      // Extract target values from recent samples
      const recent = liveSamples.slice(-pointCount);
      const rawMaxDown = Math.max(...recent.map((s) => s.down_bps), liveCurrent?.down_bps ?? 0, 0);
      const rawMaxUp = Math.max(...recent.map((s) => s.up_bps), liveCurrent?.up_bps ?? 0, 0);
      const rawPeak = Math.max(rawMaxDown, rawMaxUp);
      const targetPeak = Math.max(rawPeak, 1024 * 16);

      // Smooth peak scale transition
      smoothedPeak += (targetPeak - smoothedPeak) * 0.08;

      // Calculate target down/up points with LERP
      for (let i = 0; i < pointCount; i++) {
        const sampleIdx = recent.length - pointCount + i;
        const s = sampleIdx >= 0 ? recent[sampleIdx] : undefined;
        const downBps = s ? s.down_bps : 0;
        const upBps = s ? s.up_bps : 0;

        const targetRatioDown = Math.min(1, Math.max(0, downBps / smoothedPeak));
        const targetRatioUp = Math.min(1, Math.max(0, upBps / smoothedPeak));

        const targetScaledDown = Math.pow(targetRatioDown, 0.7);
        const targetScaledUp = Math.pow(targetRatioUp, 0.7);

        // Organic idle breathing wave
        const idleWave = active
          ? (Math.sin(elapsed * 2.5 + (i / pointCount) * Math.PI * 2) * 0.5 + 0.5) * 0.08
          : 0.02;

        const finalTargetDown = Math.max(targetScaledDown, idleWave);
        const finalTargetUp = targetScaledUp;

        // Smooth LERP per frame (fluid 60 FPS easing)
        currentDown[i] += (finalTargetDown - currentDown[i]) * 0.1;
        currentUp[i] += (finalTargetUp - currentUp[i]) * 0.1;
      }

      // Build points coordinates
      const downPoints: { x: number; y: number }[] = [];
      const upPoints: { x: number; y: number }[] = [];

      for (let i = 0; i < pointCount; i++) {
        const x = (i / (pointCount - 1)) * width;
        const yDown = bottomY - currentDown[i] * usableHeight;
        const yUp = bottomY - currentUp[i] * usableHeight;
        downPoints.push({ x, y: yDown });
        upPoints.push({ x, y: yUp });
      }

      // Draw Download Wave Fill Gradient
      const grad = ctx.createLinearGradient(0, topY, 0, bottomY);
      grad.addColorStop(0, active ? "rgba(16, 185, 129, 0.35)" : "rgba(16, 185, 129, 0.08)");
      grad.addColorStop(1, "rgba(16, 185, 129, 0.0)");

      ctx.beginPath();
      ctx.moveTo(downPoints[0].x, downPoints[0].y);
      for (let i = 0; i < downPoints.length - 1; i++) {
        const p0 = downPoints[i];
        const p1 = downPoints[i + 1];
        const mx = (p0.x + p1.x) / 2;
        ctx.bezierCurveTo(mx, p0.y, mx, p1.y, p1.x, p1.y);
      }
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Draw Download Main Curve Line with subtle glow
      ctx.beginPath();
      ctx.moveTo(downPoints[0].x, downPoints[0].y);
      for (let i = 0; i < downPoints.length - 1; i++) {
        const p0 = downPoints[i];
        const p1 = downPoints[i + 1];
        const mx = (p0.x + p1.x) / 2;
        ctx.bezierCurveTo(mx, p0.y, mx, p1.y, p1.x, p1.y);
      }
      ctx.strokeStyle = active ? "#10b981" : "#3f3f46";
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (active) {
        ctx.shadowColor = "rgba(16, 185, 129, 0.45)";
        ctx.shadowBlur = 6;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Draw Upload Line if active and has data
      if (active && rawMaxUp > 0) {
        ctx.beginPath();
        ctx.moveTo(upPoints[0].x, upPoints[0].y);
        for (let i = 0; i < upPoints.length - 1; i++) {
          const p0 = upPoints[i];
          const p1 = upPoints[i + 1];
          const mx = (p0.x + p1.x) / 2;
          ctx.bezierCurveTo(mx, p0.y, mx, p1.y, p1.x, p1.y);
        }
        ctx.strokeStyle = "#06b6d4";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw Leading Pulse Point on active
      if (active) {
        const lastPt = downPoints[downPoints.length - 1];
        const pulse = Math.sin(elapsed * 4) * 0.5 + 0.5;
        ctx.beginPath();
        ctx.arc(lastPt.x - 2, lastPt.y, 3 + pulse * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = "#34d399";
        ctx.fill();
        ctx.strokeStyle = "#090a0f";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div className="h-14 w-full pt-1 relative overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full block pointer-events-none"
      />
    </div>
  );
}

export function powerButtonClasses(statusLabel: Status): string {
  if (statusLabel === "running") {
    return "border-emerald-500/50 bg-success bg-gradient-to-tr from-emerald-500 to-teal-400 text-zinc-950 glow-button shadow-xl shadow-emerald-500/30 hover:scale-105 active:scale-95";
  }
  if (statusLabel === "starting" || statusLabel === "stopping") {
    return "border-foreground/20 bg-foreground/5";
  }
  return "border-muted-foreground/40 bg-muted/40 text-muted-foreground hover:border-foreground/50 hover:bg-muted/60 hover:text-foreground hover:scale-105 active:scale-95";
}

function connectionProfileLabel(profile: ConnectionProfile): string {
  if (profile.kind === "manual") return profileLabel(profile.outbound);
  return profile.kind === "subscription" ? profile.label : profile.name;
}

export type IndexedHomeProfile = { index: number; profile: ConnectionProfile };
export type HomeSubscriptionGroup = { id: string; rows: IndexedHomeProfile[] };
export type GroupedHomeProfiles = {
  manual: IndexedHomeProfile[];
  subscriptions: HomeSubscriptionGroup[];
};

export function subscriptionGroupLabel(
  subscriptionId: string,
  subscriptionNames: ReadonlyMap<string, string>,
): string {
  const name = subscriptionNames.get(subscriptionId)?.trim();
  return name || "Subscription";
}

export function groupHomeProfiles(profiles: ConnectionProfile[]): GroupedHomeProfiles {
  const manual: IndexedHomeProfile[] = [];
  const subscriptions: HomeSubscriptionGroup[] = [];
  const byId = new Map<string, HomeSubscriptionGroup>();

  profiles.forEach((profile, index) => {
    if (profile.kind === "manual") {
      manual.push({ index, profile });
      return;
    }

    const id = profile.kind === "subscription"
      ? profile.reference.subscription_id
      : profile.subscriptionId;
    let group = byId.get(id);
    if (!group) {
      group = { id, rows: [] };
      byId.set(id, group);
      subscriptions.push(group);
    }
    group.rows.push({ index, profile });
  });

  return { manual, subscriptions };
}

export function connectionProfileDisplay(
  profile: ConnectionProfile,
  readyProfileMetadata: ReadonlyMap<string, HomeProfileMetadata>,
  geoipByIp: Record<string, string>,
  latencyByTag: Map<string, number>,
): { flag: string; code: string; label: string; protocol: string; ms: number | undefined; key: string } {
  if (profile.kind === "subscription") {
    const flag = flagForProfile({
      tag: profile.label,
      geoipByIp,
    });
    return {
      ...flag,
      label: profile.label,
      protocol: profile.protocol,
      ms: latencyByTag.get(profile.label),
      key: `${profile.reference.subscription_id}-${profile.reference.link_key}`,
    };
  }
  if (profile.kind === "ready_config") {
    const metadata = profile.engine === "xray"
      ? readyProfileMetadata.get(`${profile.subscriptionId}:${profile.key}`)
      : undefined;
    const code = metadata?.country_code ?? "??";
    return {
      flag: code === "??" ? "🌐" : code,
      code,
      label: profile.name,
      protocol: profile.engine === "singbox" ? "sing-box" : "Xray",
      ms: metadata?.latency_ms ?? latencyByTag.get(profile.name),
      key: `${profile.subscriptionId}-${profile.key}`,
    };
  }
  const outbound = profile.outbound;
  const supported = isSupported(outbound);
  const flag = flagForProfile({
    tag: supported ? outbound.tag : undefined,
    server: supported ? outbound.server : undefined,
    geoipByIp,
  });
  return {
    ...flag,
    label: profileLabel(outbound),
    protocol: outbound.protocol,
    ms: supported ? latencyByTag.get(outbound.tag) : undefined,
    key: profileEndpoint(outbound) || outbound.protocol,
  };
}

function ProfileChoice({
  row,
  selectedIndex,
  readyProfileMetadata,
  geoipByIp,
  latencyByTag,
  onSelect,
  onSelectionDone,
  compact,
}: {
  row: IndexedHomeProfile;
  selectedIndex: number;
  readyProfileMetadata: ReadonlyMap<string, HomeProfileMetadata>;
  geoipByIp: Record<string, string>;
  latencyByTag: Map<string, number>;
  onSelect: (index: number) => void;
  onSelectionDone?: () => void;
  compact: boolean;
}) {
  const display = connectionProfileDisplay(row.profile, readyProfileMetadata, geoipByIp, latencyByTag);
  const isSelected = row.index === selectedIndex;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(row.index);
        onSelectionDone?.();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg text-left text-xs transition-colors",
        compact ? "px-2.5 py-2" : "border border-border/80 bg-[#07080c]/60 px-3 py-2 hover:bg-secondary/80",
        isSelected
          ? compact
            ? "bg-emerald-950/60 text-emerald-300 border border-emerald-800/50 font-medium"
            : "border-emerald-500/50 bg-emerald-950/40 text-emerald-300 font-medium"
          : compact
            ? "hover:bg-secondary/80 text-foreground"
            : "hover:border-border text-foreground",
      )}
    >
      <FlagIcon code={display.code} size={compact ? 16 : 14} className="shrink-0 self-center" />
      <span className="min-w-0 flex-1 truncate font-medium">{display.label}</span>
      {compact && <span className="font-mono text-[10px] text-muted-foreground">{display.protocol}</span>}
      <LatencyBadge ms={display.ms} />
    </button>
  );
}

function GroupedHomeProfileRows({
  profiles,
  selectedIndex,
  readyProfileMetadata,
  subscriptionNames,
  geoipByIp,
  latencyByTag,
  onSelect,
  onSelectionDone,
  mode,
}: {
  profiles: ConnectionProfile[];
  selectedIndex: number;
  readyProfileMetadata: ReadonlyMap<string, HomeProfileMetadata>;
  subscriptionNames: ReadonlyMap<string, string>;
  geoipByIp: Record<string, string>;
  latencyByTag: Map<string, number>;
  onSelect: (index: number) => void;
  onSelectionDone?: () => void;
  mode: "picker" | "grid";
}) {
  const grouped = groupHomeProfiles(profiles);
  // In picker mode, expand all subscription groups by default so all servers are immediately selectable
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    new Set(grouped.subscriptions.map((g) => g.id)),
  );
  const selected = profiles[selectedIndex];
  const selectedSubscriptionId = selected?.kind === "subscription"
    ? selected.reference.subscription_id
    : selected?.kind === "ready_config"
      ? selected.subscriptionId
      : null;

  useEffect(() => {
    if (selectedSubscriptionId) {
      setExpanded((current) => current.has(selectedSubscriptionId) ? current : new Set([selectedSubscriptionId, ...current]));
    }
  }, [selectedSubscriptionId]);

  const renderRows = (rows: IndexedHomeProfile[]) => rows.map((row) => (
    <li className="list-none" key={`${row.index}-${connectionProfileDisplay(row.profile, readyProfileMetadata, geoipByIp, latencyByTag).key}`}>
      <ProfileChoice
        row={row}
        selectedIndex={selectedIndex}
        readyProfileMetadata={readyProfileMetadata}
        geoipByIp={geoipByIp}
        latencyByTag={latencyByTag}
        onSelect={onSelect}
        onSelectionDone={onSelectionDone}
        compact={mode === "picker"}
      />
    </li>
  ));

  const content = (
    <>
      {grouped.manual.length > 0 && (
        <li className="list-none">
          <div className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">Manual servers</div>
          {mode === "grid" ? (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {grouped.manual.map((row) => (
                <ProfileChoice key={row.index} row={row} selectedIndex={selectedIndex} readyProfileMetadata={readyProfileMetadata} geoipByIp={geoipByIp} latencyByTag={latencyByTag} onSelect={onSelect} onSelectionDone={onSelectionDone} compact={false} />
              ))}
            </div>
          ) : <ul className="list-none space-y-1">{renderRows(grouped.manual)}</ul>}
        </li>
      )}
      {grouped.subscriptions.map((group) => {
        const isExpanded = expanded.has(group.id);
        return (
          <li className="list-none" key={group.id}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                  return next;
                });
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition"
              aria-expanded={isExpanded}
            >
              <ChevronDown className={cn("h-3 w-3 transition-transform", !isExpanded && "-rotate-90")} />
              <span className="min-w-0 flex-1 truncate font-medium">{subscriptionGroupLabel(group.id, subscriptionNames)}</span>
              <span className="font-mono normal-case rounded bg-background/50 px-1.5 py-0.2 text-[10px]">{group.rows.length}</span>
            </button>
            {isExpanded && (mode === "grid" ? (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 pt-1">
                {group.rows.map((row) => (
                  <ProfileChoice key={row.index} row={row} selectedIndex={selectedIndex} readyProfileMetadata={readyProfileMetadata} geoipByIp={geoipByIp} latencyByTag={latencyByTag} onSelect={onSelect} onSelectionDone={onSelectionDone} compact={false} />
                ))}
              </div>
            ) : <ul className="list-none space-y-1 pt-1">{renderRows(group.rows)}</ul>)}
          </li>
        );
      })}
    </>
  );

  return mode === "grid" ? <div className="space-y-2">{content}</div> : content;
}

/**
 * Compact dropdown-style server picker rendered above the hero icon.
 * Click → menu with the full list; click outside → closes.
 */
function ServerPicker({
  profiles,
  selectedIndex,
  latencyByTag,
  readyProfileMetadata,
  subscriptionNames,
  geoipByIp,
  onSelect,
}: {
  profiles: ConnectionProfile[];
  selectedIndex: number;
  latencyByTag: Map<string, number>;
  readyProfileMetadata: ReadonlyMap<string, HomeProfileMetadata>;
  subscriptionNames: ReadonlyMap<string, string>;
  geoipByIp: Record<string, string>;
  onSelect: (i: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const selected = profiles[selectedIndex];
  const selectedDisplay = selected
    ? connectionProfileDisplay(selected, readyProfileMetadata, geoipByIp, latencyByTag)
    : null;
  const selectedFlag = selectedDisplay ?? { flag: "🌐", code: "??", label: "No servers", ms: undefined, key: "none", protocol: "" };
  const selectedName = selectedDisplay?.label ?? "No servers";
  const selectedMs = selectedDisplay?.ms;

  return (
    <div ref={ref} className="relative z-50">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((value) => !value);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={profiles.length === 0}
        className={cn(
          "flex items-center gap-2 rounded-full border border-border/80 bg-background/80 px-3 py-1.5 text-xs shadow-sm",
          "hover:bg-secondary hover:border-border transition-all disabled:opacity-50",
        )}
      >
        <FlagIcon code={selectedFlag.code} size={16} className="shrink-0" />
        <span className="max-w-[180px] truncate font-medium">{selectedName}</span>
        <LatencyBadge ms={selectedMs} compact />
        <ChevronDown
          className={cn(
            "h-3 w-3 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && profiles.length > 0 && (
        <div
          className={cn(
            "absolute left-0 top-full z-[100] mt-2",
            "w-84 max-h-96 overflow-y-auto rounded-xl border border-border/90 bg-[#0c0d14] shadow-2xl shadow-black/95 p-1.5 backdrop-blur-xl ring-1 ring-white/10",
          )}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <ul className="space-y-1">
            {/* "Auto" entry */}
            <li>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(-1);
                  setOpen(false);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition",
                  selectedIndex === -1
                    ? "bg-emerald-950/60 text-emerald-300 border border-emerald-800/50 font-medium"
                    : "hover:bg-secondary/80 text-foreground",
                )}
              >
                <span
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[8px] text-muted-foreground"
                  aria-hidden
                >
                  ∞
                </span>
                <span className="flex-1 truncate font-medium">
                  Auto (best latency)
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  urltest
                </span>
              </button>
            </li>
            <GroupedHomeProfileRows
              profiles={profiles}
              selectedIndex={selectedIndex}
              readyProfileMetadata={readyProfileMetadata}
              subscriptionNames={subscriptionNames}
              geoipByIp={geoipByIp}
              latencyByTag={latencyByTag}
              onSelect={(idx) => {
                onSelect(idx);
                setOpen(false);
              }}
              onSelectionDone={() => setOpen(false)}
              mode="picker"
            />
          </ul>
        </div>
      )}
    </div>
  );
}

/** Compact "▮▮▮▮ 47ms" badge. `compact` drops the bars (just the
 *  number) for the small pill at the top of the hero. */
function LatencyBadge({ ms, compact = false }: { ms: number | undefined; compact?: boolean }) {
  if (ms == null) {
    return (
      <span className="font-mono text-[10px] text-muted-foreground/60">—</span>
    );
  }
  const bars = latencyToBars(ms);
  return (
    <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground">
      {!compact && <SignalBars level={bars} />}
      <span>{ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}</span>
    </span>
  );
}

/** Four little vertical bars, lit up to `level` (0..4). */
function SignalBars({ level }: { level: number }) {
  const heights = [3, 5, 7, 9];
  return (
    <span className="flex items-end gap-[1.5px]" aria-label={`signal ${level} of 4`}>
      {heights.map((h, i) => (
        <span
          key={i}
          className={cn(
            "w-[2px] rounded-sm",
            i < level ? "bg-foreground/70" : "bg-foreground/15",
          )}
          style={{ height: h }}
        />
      ))}
    </span>
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "truncate text-sm",
          mono && "font-mono",
          (!value || value === "—") && "text-muted-foreground",
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function formatRate(bps: number): string {
  if (!bps) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = bps;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatBytes(b: number): string {
  if (!b) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(secs: number | null | undefined): string {
  if (secs == null) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
