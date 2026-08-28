import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Loader2,
  Plus,
  Power,
  Server,
  Shield,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { FlagIcon } from "@/components/FlagIcon";
import { useTrafficStream } from "@/hooks/useTrafficStream";
import { useServerLatency } from "@/hooks/useServerLatency";
import { api } from "@/lib/api";
import { flagForProfile } from "@/lib/flags";
import { isSupported, profileEndpoint, profileLabel } from "@/lib/outbound";
import { cn } from "@/lib/utils";
import type { ChildProfileSummary, GeneratorSettings, Outbound, Subscription, TrafficSample } from "@/lib/types";
import type { ServerGroup } from "../lib/serverGrouping";
import { buildHomeServerCatalog } from "../lib/homeServerCatalog";
import type { VpnConnection } from "../useVpnConnection";
import { summarizeRoutingPolicy } from "../lib/mobileUi";
import { AddSubscriptionSheet } from "../components/AddSubscriptionSheet";
import { Sheet } from "../components/Sheet";
import { formatBytes, formatMs, formatRate, formatUptime } from "../lib/format";
import { triggerHaptic } from "../lib/haptics";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function HomeScreen({
  vpn,
  profiles,
  groups,
  selectedIndex,
  geoipByIp,
  settings,
  onSelect,
  onOpenServers,
  onOpenRouting,
  activeBundle,
  onConnect,
  subs,
  onSelectBundleChild,
  onAddSub,
  onAddLinks,
}: {
  vpn: VpnConnection;
  profiles: Outbound[];
  groups: ServerGroup[];
  selectedIndex: number;
  geoipByIp: Record<string, string>;
  settings: GeneratorSettings;
  onSelect: (index: number) => void;
  onOpenServers: () => void;
  onOpenRouting: () => void;
  /** Subscription summaries */
  subs: Subscription[];
  /** Pin a bundle child as the active target */
  onSelectBundleChild: (input: {
    subscriptionId: string;
    childKey: string;
    engine: "singbox" | "xray";
    childName: string;
  }) => void | Promise<void>;
  /** Active bundle child */
  activeBundle: {
    subscriptionId: string;
    childKey: string;
    engine: "singbox" | "xray";
    childName: string;
  } | null;
  /** Connect handler */
  onConnect: () => Promise<void> | void;
  onAddSub?: (input: { name?: string; url: string }) => Promise<void>;
  onAddLinks?: (outbounds: Outbound[]) => void;
}) {
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);

  const isRunning = vpn.state === "running";
  const isTransition = vpn.state === "starting";
  const traffic = useTrafficStream(isRunning || !inTauri, profiles.length);
  const current = traffic.current;

  const latencyState = useServerLatency(profiles);

  const childEndpoints = useMemo(
    () =>
      subs
        .filter((s) => s.kind === "xray_bundle" || s.kind === "singbox_bundle")
        .flatMap((s) =>
          s.children
            .filter((c) => c.endpoint)
            .map((c) => ({
              key: `${s.id}:${c.key}`,
              host: c.endpoint!.host,
              port: c.endpoint!.port,
            })),
        ),
    [subs],
  );

  const [childLatency, setChildLatency] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (childEndpoints.length === 0 || !inTauri) return;
    let cancelled = false;
    const probe = async () => {
      const results = await Promise.allSettled(
        childEndpoints.map((c) =>
          api.pingEndpoint(c.host, c.port, 2000),
        ),
      );
      if (cancelled) return;
      const next = new Map<string, number>();
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value != null) {
          next.set(childEndpoints[i].key, r.value);
        }
      });
      setChildLatency(next);
    };
    void probe();
    const timer = window.setInterval(() => void probe(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [childEndpoints]);

  // 1 Hz ticker for uptime counter while connected
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const t = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [isRunning]);

  const selected =
    selectedIndex >= 0 && selectedIndex < profiles.length
      ? profiles[selectedIndex]
      : undefined;
  const selectedSupported = selected && isSupported(selected) ? selected : null;
  const flag = selectedSupported
    ? flagForProfile({
        tag: selectedSupported.tag,
        server: selectedSupported.server,
        geoipByIp,
      })
    : null;

  const headline =
    vpn.state === "running"
      ? "Connected"
      : vpn.state === "starting"
        ? "Connecting…"
        : vpn.state === "error"
          ? "Error"
          : "Disconnected";

  const serverLine = activeBundle
    ? activeBundle.childName
    : !selectedSupported
      ? "Auto (best latency)"
      : profileLabel(selectedSupported);

  const routingSummary = summarizeRoutingPolicy(
    settings.routing.final_outbound,
    settings.routing.tun_app_mode,
    settings.routing.tun_app_list ?? [],
  );
  const serverCatalog = buildHomeServerCatalog(groups, selectedIndex);

  const uptimeSecs =
    isRunning && vpn.since
      ? Math.max(0, Math.floor((Date.now() - vpn.since) / 1000))
      : null;

  type ServerBlock =
    | { type: "manual" | "links"; id: string; label: string; entries: typeof serverCatalog[number]["entries"] }
    | { type: "bundle"; id: string; label: string; children: ChildProfileSummary[] };

  const blocks = useMemo<ServerBlock[]>(() => {
    const result: ServerBlock[] = [];
    for (const group of serverCatalog) {
      if (group.kind === "manual") {
        result.push({ type: "manual", id: group.id, label: group.label, entries: group.entries });
      }
    }
    const groupedBySub = new Map(
      serverCatalog
        .filter((g) => g.kind === "subscription" && g.subscriptionId)
        .map((g) => [g.subscriptionId!, g]),
    );
    for (const sub of subs) {
      if (sub.kind === "xray_bundle" || sub.kind === "singbox_bundle") {
        result.push({
          type: "bundle",
          id: sub.id,
          label: sub.name.trim() || "Subscription",
          children: sub.children,
        });
      } else {
        const group = groupedBySub.get(sub.id);
        result.push({
          type: "links",
          id: `subscription:${sub.id}`,
          label: sub.name.trim() || "Subscription",
          entries: group?.entries ?? [],
        });
      }
    }
    return result;
  }, [serverCatalog, subs]);

  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(
    () =>
      new Set(
        blocks
          .filter((b) => b.type !== "manual" && !blockHoldsSelection(b))
          .map((b) => b.id),
      ),
  );

  function blockHoldsSelection(block: ServerBlock): boolean {
    if (block.type === "bundle") {
      return !!activeBundle && activeBundle.subscriptionId === block.id;
    }
    return block.entries.some((entry) => entry.selected);
  }

  const toggleBlock = (id: string) => {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalServersCount = useMemo(() => {
    return blocks.reduce((acc, b) => acc + (b.type === "bundle" ? b.children.length : b.entries.length), 0);
  }, [blocks]);

  return (
    <div className="flex flex-col gap-4 p-4 pb-8">
      {/* ─── Bento 1: Primary Hero Connection Card ────────────────── */}
      <div className="bento-card relative flex flex-col justify-between overflow-hidden rounded-3xl p-5 shadow-xl">
        <div className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-emerald-500/10 blur-3xl" />

        {/* Top Active Server Selector Pill */}
        <div className="relative z-10 flex w-full items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setServerPickerOpen(true)}
            className={cn(
              "flex items-center gap-2 rounded-full border border-white/10 bg-background/80 px-3 py-1.5 text-xs shadow-sm backdrop-blur-md",
              "active:bg-secondary transition-all max-w-[200px] truncate",
            )}
          >
            {flag ? (
              <FlagIcon code={flag.code} size={15} className="shrink-0" />
            ) : (
              <span className="text-xs">🌐</span>
            )}
            <span className="truncate font-medium text-foreground">{serverLine}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>

          <span className="rounded-lg border border-white/10 bg-background/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground shadow-sm">
            {vpn.engine === "xray" ? "Xray Core" : "sing-box"}
          </span>
        </div>

        {/* Center Tactile Power Orb */}
        <div className="relative z-10 my-6 flex flex-col items-center justify-center text-center">
          <div className="relative flex items-center justify-center">
            {isRunning && (
              <div className="pointer-events-none absolute h-32 w-32 animate-ping rounded-full bg-emerald-500/20 opacity-40" />
            )}
            <button
              type="button"
              onClick={() => {
                triggerHaptic("medium");
                if (isRunning) void vpn.disconnect();
                else void onConnect();
              }}
              disabled={vpn.busy || isTransition || !vpn.ready}
              aria-label={isRunning ? "Disconnect" : "Connect"}
              className={cn(
                "group relative flex h-28 w-28 items-center justify-center rounded-full",
                "border-2 transition-all duration-300",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
                "disabled:cursor-not-allowed",
                isRunning
                  ? "border-emerald-500/50 bg-gradient-to-tr from-emerald-500 to-teal-400 text-zinc-950 shadow-xl shadow-emerald-500/30 active:scale-95"
                  : isTransition
                    ? "border-foreground/20 bg-foreground/5 text-foreground/70"
                    : "border-muted-foreground/40 bg-muted/40 text-muted-foreground active:scale-95 hover:border-foreground/40 hover:text-foreground",
              )}
            >
              {isTransition ? (
                <Loader2 className="h-10 w-10 animate-spin text-foreground/80" />
              ) : (
                <Power
                  className={cn(
                    "h-11 w-11 transition-transform group-hover:scale-110",
                    isRunning ? "stroke-[2.5] text-zinc-950" : "text-muted-foreground",
                  )}
                />
              )}
            </button>
          </div>

          <div className="mt-4 space-y-1">
            <div className="flex items-center justify-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-foreground">{headline}</h1>
              {isRunning && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800/60 bg-emerald-950/80 px-2 py-0.5 text-[10px] text-emerald-400">
                  <Sparkles className="h-2.5 w-2.5" />
                  live
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={onOpenServers}
              className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground active:opacity-80 mx-auto"
            >
              {isRunning ? (
                <>
                  <span>via</span>
                  {flag && <FlagIcon code={flag.code} size={14} className="self-center" />}
                  <span className="font-medium text-foreground">{serverLine}</span>
                </>
              ) : profiles.length === 0 ? (
                <span>Add a server to get started</span>
              ) : (
                <>
                  <span>Ready:</span>
                  {flag && <FlagIcon code={flag.code} size={14} className="self-center" />}
                  <span className="font-medium text-foreground">{serverLine}</span>
                </>
              )}
            </button>

            {isRunning && uptimeSecs != null && (
              <p className="pt-0.5 font-mono text-[10px] text-muted-foreground/70">
                uptime {formatUptime(uptimeSecs)}
              </p>
            )}

            {vpn.state === "error" && (vpn.message || vpn.error) && (
              <p className="max-w-[280px] pt-1 text-xs text-destructive">
                {vpn.message || vpn.error}
              </p>
            )}
          </div>
        </div>

        {/* Hero Footer */}
        <div className="relative z-10 flex items-center justify-between border-t border-white/5 pt-3 text-[11px] font-mono text-muted-foreground/70">
          <span>TUN Mode • Protected</span>
          <span>{vpn.engine === "xray" ? "Xray Core" : "sing-box Core"}</span>
        </div>
      </div>

      {/* ─── Bento 2: Live Traffic & 60 FPS Speed Wave ────────────── */}
      <div className="bento-card flex flex-col justify-between rounded-3xl p-4 shadow-xl">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Live Traffic
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {isRunning ? (vpn.engine ? `${vpn.engine} engine` : "sing-box") : "idle"}
          </span>
        </div>

        <div className="mb-2 grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-white/5 bg-background/50 p-2.5 shadow-sm">
            <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <TrendingDown className="h-3.5 w-3.5 text-emerald-400" />
              Download
            </div>
            <p className="mt-1 font-mono text-lg font-bold tabular-nums text-foreground">
              {formatRate(current?.down_bps ?? 0)}
            </p>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
              total {formatBytes(current?.down_total ?? 0)}
            </p>
          </div>

          <div className="rounded-xl border border-white/5 bg-background/50 p-2.5 shadow-sm">
            <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5 text-cyan-400" />
              Upload
            </div>
            <p className="mt-1 font-mono text-lg font-bold tabular-nums text-foreground">
              {formatRate(current?.up_bps ?? 0)}
            </p>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
              total {formatBytes(current?.up_total ?? 0)}
            </p>
          </div>
        </div>

        {/* 60 FPS Buttery-Smooth Speed Wave */}
        <MobileSparklineWave isRunning={isRunning} samples={traffic.samples} current={current} />
      </div>

      {/* ─── Bento 3: Per-App Routing Summary ─────────────────────── */}
      <div className="bento-card flex flex-col justify-between rounded-3xl p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            <Shield className="h-3.5 w-3.5 text-emerald-400" />
            Per-App Routing
          </div>
          <button
            type="button"
            onClick={onOpenRouting}
            className="flex items-center gap-0.5 text-xs font-medium text-emerald-400 hover:underline active:opacity-80"
          >
            Manage ↗
          </button>
        </div>
        <button
          type="button"
          onClick={onOpenRouting}
          className="mt-1.5 text-left active:opacity-80"
        >
          <p className="text-xs text-muted-foreground leading-relaxed" title={routingSummary}>
            {routingSummary}
          </p>
        </button>
      </div>

      {/* ─── Bento 4: All Servers List & Quick Add ────────────────── */}
      <div className="bento-card flex flex-col rounded-3xl p-4 shadow-xl">
        <div className="mb-2 flex items-center justify-between px-1">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
            <Server className="h-3.5 w-3.5 text-emerald-400" />
            <span>All Servers</span>
            <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {totalServersCount}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAddSheetOpen(true)}
            className="flex items-center gap-1 rounded-xl border border-emerald-500/40 bg-emerald-950/60 px-3 py-1 text-xs font-medium text-emerald-300 shadow-sm transition active:scale-95"
            title="Add server or subscription"
          >
            <Plus className="h-3.5 w-3.5 stroke-[2.5]" />
            <span>Add</span>
          </button>
        </div>

        <div className="divide-y divide-white/5">
          {blocks.map((block) => {
            const collapsed = collapsedBlocks.has(block.id);
            return (
              <div key={block.id} className="py-1">
                {block.type === "manual" ? (
                  block.entries.length > 1 && (
                    <div className="px-1 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
                      {block.label} ({block.entries.length})
                    </div>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleBlock(block.id)}
                    aria-expanded={!collapsed}
                    className="flex w-full items-center justify-between px-1 py-2.5 text-left transition active:opacity-80"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {block.label}
                      </span>
                      <span className="shrink-0 rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {block.type === "bundle" ? block.children.length : block.entries.length}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                        collapsed && "-rotate-90",
                      )}
                    />
                  </button>
                )}

                {!collapsed && (
                  block.type === "bundle" ? (
                    block.children.length === 0 ? (
                      <p className="px-1 py-2 text-xs text-muted-foreground">
                        No servers loaded
                      </p>
                    ) : (
                      <ul className="divide-y divide-white/5">
                        {block.children.map((child) => {
                          const isSel =
                            !!activeBundle &&
                            activeBundle.subscriptionId === block.id &&
                            activeBundle.childKey === child.key;
                          const latency = childLatency.get(`${block.id}:${child.key}`);
                          return (
                            <li key={`home-bundle-${block.id}-${child.key}`}>
                              <button
                                type="button"
                                onClick={() => {
                                  triggerHaptic("selection");
                                  void onSelectBundleChild({
                                    subscriptionId: block.id,
                                    childKey: child.key,
                                    engine: child.engine === "xray" ? "xray" : "singbox",
                                    childName: child.name,
                                  });
                                }}
                                className={cn(
                                  "flex w-full items-center gap-3.5 rounded-xl px-2 py-3 text-left transition-colors",
                                  isSel ? "bg-emerald-500/10 text-emerald-300 font-medium" : "active:bg-white/5",
                                )}
                              >
                                <span
                                  className={cn(
                                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition",
                                    isSel
                                      ? "border-emerald-400 bg-emerald-500/20"
                                      : "border-white/20",
                                  )}
                                >
                                  {isSel && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-foreground">
                                    {child.name}
                                  </span>
                                  {child.endpoint && (
                                    <span className="block truncate font-mono text-[11px] text-muted-foreground/80">
                                      {child.endpoint.host}:{child.endpoint.port}
                                    </span>
                                  )}
                                </span>
                                <LatencyBadge ms={latency} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )
                  ) : block.entries.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      No servers loaded
                    </p>
                  ) : (
                    <ul className="divide-y divide-white/5">
                      {block.entries.map((entry) => {
                        const profile = entry.profile;
                        const supported = isSupported(profile);
                        const { code } = flagForProfile({
                          tag: supported ? profile.tag : undefined,
                          server: supported ? profile.server : undefined,
                          geoipByIp,
                        });
                        const ep = supported ? profileEndpoint(profile) : null;
                        const latency = supported ? latencyState.byTag.get(profile.tag) : undefined;
                        return (
                          <li key={`home-server-${entry.profileIndex}`}>
                            <button
                              type="button"
                              onClick={() => {
                                if (supported) {
                                  triggerHaptic("selection");
                                  onSelect(entry.profileIndex);
                                }
                              }}
                              disabled={!supported}
                              className={cn(
                                "flex w-full items-center gap-3.5 rounded-xl px-2 py-3 text-left transition-colors",
                                entry.selected ? "bg-emerald-500/10 text-emerald-300 font-medium" : "active:bg-white/5",
                                !supported && "cursor-not-allowed opacity-50",
                              )}
                            >
                              <span
                                className={cn(
                                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition",
                                  entry.selected
                                    ? "border-emerald-400 bg-emerald-500/20"
                                    : "border-white/20",
                                )}
                              >
                                {entry.selected && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                              </span>

                              {code ? (
                                <FlagIcon code={code} size={18} className="shrink-0" />
                              ) : (
                                <span className="text-base">🌐</span>
                              )}

                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-foreground">
                                  {profileLabel(profile)}
                                </span>
                                <span className="block truncate font-mono text-[11px] text-muted-foreground/80">
                                  {supported ? ep : "unsupported link"}
                                </span>
                              </span>

                              <LatencyBadge ms={latency} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Server Picker Bottom Sheet ───────────────────────────── */}
      <Sheet
        open={serverPickerOpen}
        onClose={() => setServerPickerOpen(false)}
        title="Select active server"
      >
        <div className="space-y-3 pb-4">
          <button
            type="button"
            onClick={() => {
              onSelect(-1);
              setServerPickerOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition",
              selectedIndex === -1
                ? "bg-emerald-950/60 text-emerald-300 border-emerald-500/40 font-medium"
                : "bg-[#07080c] border-white/5 active:bg-secondary/80 text-foreground",
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">
              ∞
            </span>
            <div className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Auto (best latency)</span>
              <span className="block font-mono text-[11px] text-muted-foreground">urltest</span>
            </div>
          </button>

          {blocks.map((block) => (
            <div key={`sheet-block-${block.id}`} className="space-y-1.5 pt-1">
              <p className="px-1 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                {block.label}
              </p>
              {block.type === "bundle" ? (
                <div className="space-y-1">
                  {block.children.map((child) => {
                    const isSel =
                      !!activeBundle &&
                      activeBundle.subscriptionId === block.id &&
                      activeBundle.childKey === child.key;
                    const latency = childLatency.get(`${block.id}:${child.key}`);
                    return (
                      <button
                        key={`sheet-child-${child.key}`}
                        type="button"
                        onClick={() => {
                          void onSelectBundleChild({
                            subscriptionId: block.id,
                            childKey: child.key,
                            engine: child.engine === "xray" ? "xray" : "singbox",
                            childName: child.name,
                          });
                          setServerPickerOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition",
                          isSel
                            ? "bg-emerald-950/60 text-emerald-300 border-emerald-500/40 font-medium"
                            : "bg-[#07080c] border-white/5 active:bg-secondary/80 text-foreground",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{child.name}</span>
                        <LatencyBadge ms={latency} />
                        <span className="font-mono text-[10px] text-muted-foreground/70">{child.engine}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-1">
                  {block.entries.map((entry) => {
                    const profile = entry.profile;
                    const supported = isSupported(profile);
                    const { code } = flagForProfile({
                      tag: supported ? profile.tag : undefined,
                      server: supported ? profile.server : undefined,
                      geoipByIp,
                    });
                    const latency = supported ? latencyState.byTag.get(profile.tag) : undefined;
                    return (
                      <button
                        key={`sheet-entry-${entry.profileIndex}`}
                        type="button"
                        onClick={() => {
                          if (supported) {
                            triggerHaptic("selection");
                            onSelect(entry.profileIndex);
                            setServerPickerOpen(false);
                          }
                        }}
                        disabled={!supported}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition",
                          entry.selected
                            ? "bg-emerald-950/60 text-emerald-300 border-emerald-500/40 font-medium"
                            : "bg-[#07080c] border-white/5 active:bg-secondary/80 text-foreground",
                          !supported && "opacity-50",
                        )}
                      >
                        {code ? (
                          <FlagIcon code={code} size={16} className="shrink-0" />
                        ) : (
                          <span className="text-sm">🌐</span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{profileLabel(profile)}</span>
                        <LatencyBadge ms={latency} />
                        <span className="font-mono text-[10px] text-muted-foreground/70">{profile.protocol}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </Sheet>

      {/* ─── Add Subscription / Link Sheet ───────────────────────── */}
      {onAddSub && onAddLinks && (
        <AddSubscriptionSheet
          open={addSheetOpen}
          onClose={() => setAddSheetOpen(false)}
          onAdd={onAddSub}
          onAddLinks={onAddLinks}
        />
      )}
    </div>
  );
}

/** 60 FPS Canvas LERP Smooth Speed Wave for Mobile */
function MobileSparklineWave({
  isRunning,
  samples,
  current,
}: {
  isRunning: boolean;
  samples: TrafficSample[];
  current: TrafficSample | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
    const pointCount = 24;
    const currentDown = new Float32Array(pointCount);
    const currentUp = new Float32Array(pointCount);
    let smoothedPeak = 1024 * 32;

    const startTime = performance.now();

    const render = (now: number) => {
      const { samples: liveSamples, current: liveCurrent, isRunning: active } = dataRef.current;
      const elapsed = (now - startTime) / 1000;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 280;
      const height = canvas.clientHeight || 50;
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const bottomY = height - 5;
      const topY = 5;
      const usableHeight = bottomY - topY;

      const recent = liveSamples.slice(-pointCount);
      const rawMaxDown = Math.max(...recent.map((s) => s.down_bps), liveCurrent?.down_bps ?? 0, 0);
      const rawMaxUp = Math.max(...recent.map((s) => s.up_bps), liveCurrent?.up_bps ?? 0, 0);
      const rawPeak = Math.max(rawMaxDown, rawMaxUp);
      const targetPeak = Math.max(rawPeak, 1024 * 16);

      smoothedPeak += (targetPeak - smoothedPeak) * 0.08;

      for (let i = 0; i < pointCount; i++) {
        const sampleIdx = recent.length - pointCount + i;
        const s = sampleIdx >= 0 ? recent[sampleIdx] : undefined;
        const downBps = s ? s.down_bps : 0;
        const upBps = s ? s.up_bps : 0;

        const targetRatioDown = Math.min(1, Math.max(0, downBps / smoothedPeak));
        const targetRatioUp = Math.min(1, Math.max(0, upBps / smoothedPeak));

        const targetScaledDown = Math.pow(targetRatioDown, 0.7);
        const targetScaledUp = Math.pow(targetRatioUp, 0.7);

        const idleWave = active
          ? (Math.sin(elapsed * 2.5 + (i / pointCount) * Math.PI * 2) * 0.5 + 0.5) * 0.08
          : 0.02;

        const finalTargetDown = Math.max(targetScaledDown, idleWave);
        const finalTargetUp = targetScaledUp;

        currentDown[i] += (finalTargetDown - currentDown[i]) * 0.1;
        currentUp[i] += (finalTargetUp - currentUp[i]) * 0.1;
      }

      const downPoints: { x: number; y: number }[] = [];
      const upPoints: { x: number; y: number }[] = [];

      for (let i = 0; i < pointCount; i++) {
        const x = (i / (pointCount - 1)) * width;
        const yDown = bottomY - currentDown[i] * usableHeight;
        const yUp = bottomY - currentUp[i] * usableHeight;
        downPoints.push({ x, y: yDown });
        upPoints.push({ x, y: yUp });
      }

      // Download fill gradient
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

      // Download stroke line
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

      // Upload stroke line
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

      // Active pulse point
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
    <div className="h-12 w-full pt-1 relative overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full block pointer-events-none"
      />
    </div>
  );
}

function LatencyBadge({ ms }: { ms: number | undefined }) {
  if (ms == null) return null;
  const tone = ms < 250 ? "fast" : ms < 700 ? "medium" : "slow";
  const toneClass =
    tone === "fast"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
      : tone === "medium"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
        : "border-red-500/30 bg-red-500/10 text-red-400";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] tabular-nums shrink-0",
        toneClass,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {formatMs(ms)}
    </span>
  );
}

