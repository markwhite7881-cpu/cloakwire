import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Loader2,
  Power,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { FlagIcon } from "@/components/FlagIcon";
import { useTrafficStream } from "@/hooks/useTrafficStream";
import { flagForProfile } from "@/lib/flags";
import { isSupported, profileEndpoint, profileLabel } from "@/lib/outbound";
import { cn } from "@/lib/utils";
import type { ChildProfileSummary, GeneratorSettings, Outbound, Subscription } from "@/lib/types";
import type { ServerGroup } from "../lib/serverGrouping";
import { buildHomeServerCatalog } from "../lib/homeServerCatalog";
import type { VpnConnection } from "../useVpnConnection";
import { summarizeRoutingPolicy } from "../lib/mobileUi";
import { SectionCard, SectionHeader } from "../components/SectionCard";
import { formatRateMBps, formatUptime } from "../lib/format";

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
  /** Subscription summaries — bundle children become their own
   *  collapsible server blocks on Home (desktop-style). */
  subs: Subscription[];
  /** Pin a bundle child as the active target (same contract as the
   *  Servers screen picker). */
  onSelectBundleChild: (input: {
    subscriptionId: string;
    childKey: string;
    engine: "singbox" | "xray";
    childName: string;
  }) => void | Promise<void>;
  /** Active bundle child (if any). When set, the hero shows the
   *  child name and the connect button uses the bundle config
   *  path. 2026-08-20. */
  activeBundle: {
    subscriptionId: string;
    childKey: string;
    engine: "singbox" | "xray";
    childName: string;
  } | null;
  /** Connect handler that honours the active bundle pick. */
  onConnect: () => Promise<void> | void;
}) {
  const isRunning = vpn.state === "running";
  const isTransition = vpn.state === "starting";
  const traffic = useTrafficStream(isRunning || !inTauri, profiles.length);
  const current = traffic.current;

  // 1 Hz ticker so the uptime counter advances while connected.
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

  // When a bundle child is the active target, surface its name as
  // the active server line so the hero tells the user what the
  // next connect will actually use. 2026-08-20.
  const serverLine = activeBundle
    ? `${activeBundle.childName}  ·  ${activeBundle.engine}`
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

  // Desktop-style server list: a plain Manual section plus one
  // collapsible block per subscription (named by the subscription).
  // Link-list subscriptions render their grouped profiles; bundles
  // render their children directly.
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

  // Subscription blocks start collapsed unless they hold the active
  // pick; Manual stays always-open.
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

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Hero: connect button + state. The card background is
          transparent so the page bg shows through — only the rounded
          outline + content (button, headline, speed bar) sit on it. */}
      <SectionCard className="flex flex-col items-center gap-5 bg-transparent px-4 py-8 text-center">
        <button
          type="button"
          onClick={() => {
            if (isRunning) void vpn.disconnect();
            else void onConnect();
          }}
          disabled={vpn.busy || isTransition || !vpn.ready}
          aria-label={isRunning ? "Disconnect" : "Connect"}
          className={cn(
            "group relative flex h-28 w-28 items-center justify-center rounded-full",
            "border-2 transition-all duration-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
            "disabled:cursor-not-allowed",
            isRunning
              ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-300 shadow-[0_0_50px_rgba(52,211,153,0.22)] ring-4 ring-emerald-400/10 hover:bg-emerald-500/25"
              : isTransition
                ? "border-foreground/20 bg-foreground/5"
                : "border-muted-foreground/40 bg-muted/40 text-muted-foreground active:border-foreground/50 active:text-foreground",
          )}
        >
          {isTransition ? (
            <Loader2 className="h-11 w-11 animate-spin text-foreground/70" />
          ) : (
            <Power
              className={cn(
                "h-11 w-11 transition-transform group-hover:scale-110",
                isRunning &&
                  "text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.5)]",
              )}
            />
          )}
        </button>

        {isRunning && uptimeSecs != null && (
          <p className="-mt-2 font-mono text-[11px] tabular-nums text-muted-foreground">
            up {formatUptime(uptimeSecs)}
          </p>
        )}

        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{headline}</h1>
          {vpn.engine && (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5",
                "text-[10px] font-mono uppercase tracking-wider",
                vpn.engine === "xray"
                  ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
                  : "border-sky-400/40 bg-sky-500/10 text-sky-200",
              )}
              title={`VPN engine: ${vpn.engine}`}
            >
              {vpn.engine}
            </span>
          )}
          <button
            type="button"
            onClick={onOpenServers}
            className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground"
          >
            {flag && <FlagIcon code={flag.code} size={14} className="self-center" />}
            <span className="max-w-[240px] truncate">{serverLine}</span>
          </button>
          {vpn.state === "error" && vpn.message && (
            <p className="max-w-[280px] text-xs text-destructive">{vpn.message}</p>
          )}
          {vpn.error && (
            <p className="max-w-[280px] text-xs text-destructive">{vpn.error}</p>
          )}
        </div>

        {/* Live speed monitor — sits inside the connect button card so
            the rate updates are anchored to the action that produced
            them. Only shown while the tunnel is up. */}
        {isRunning && (
          <div className="mt-1 flex w-full max-w-[300px] items-stretch overflow-hidden rounded-xl border border-border font-mono">
            <div className="flex flex-1 flex-col items-center gap-0.5 px-3 py-2">
              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                <TrendingDown className="h-3 w-3" />
                Down
              </span>
              <span className="text-base font-semibold tabular-nums text-foreground">
                {formatRateMBps(current?.down_bps ?? 0)}
              </span>
            </div>
            <div className="my-2 w-px bg-border" />
            <div className="flex flex-1 flex-col items-center gap-0.5 px-3 py-2">
              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                Up
              </span>
              <span className="text-base font-semibold tabular-nums text-foreground">
                {formatRateMBps(current?.up_bps ?? 0)}
              </span>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard className="grid divide-y divide-border overflow-hidden sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <button
          type="button"
          onClick={onOpenServers}
          className="min-w-0 px-3.5 py-3 text-left active:bg-accent"
        >
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Server</p>
          <p className="mt-1 flex items-center gap-1.5 truncate text-sm font-medium">
            {flag && <FlagIcon code={flag.code} size={14} className="shrink-0" />}
            <span className="truncate">{serverLine}</span>
          </p>
        </button>
        <button
          type="button"
          onClick={onOpenRouting}
          className="min-w-0 px-3.5 py-3 text-left active:bg-accent"
        >
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Routing</p>
          <p className="mt-1 truncate text-sm font-medium" title={routingSummary}>{routingSummary}</p>
        </button>
      </SectionCard>

      <div className="flex flex-col gap-3">
        {blocks.map((block) => {
          const collapsed = collapsedBlocks.has(block.id);
          const header =
            block.type === "manual" ? (
              <SectionHeader title={block.label} />
            ) : (
              <button
                type="button"
                onClick={() => toggleBlock(block.id)}
                aria-expanded={!collapsed}
                className="flex w-full items-center justify-between px-3.5 py-3 text-left active:bg-accent/60"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold tracking-tight">
                    {block.label}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {block.type === "bundle" ? block.children.length : block.entries.length}
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                    collapsed && "-rotate-90",
                  )}
                />
              </button>
            );
          return (
            <SectionCard key={block.id}>
              {header}
              {!collapsed && (
                block.type === "bundle" ? (
                  block.children.length === 0 ? (
                    <p className="px-3.5 py-3 text-xs text-muted-foreground">
                      No servers loaded
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {block.children.map((child) => {
                        const isSel =
                          !!activeBundle &&
                          activeBundle.subscriptionId === block.id &&
                          activeBundle.childKey === child.key;
                        return (
                          <li key={`home-bundle-${block.id}-${child.key}`}>
                            <button
                              type="button"
                              onClick={() =>
                                void onSelectBundleChild({
                                  subscriptionId: block.id,
                                  childKey: child.key,
                                  engine: child.engine === "xray" ? "xray" : "singbox",
                                  childName: child.name,
                                })
                              }
                              className={cn(
                                "flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors",
                                isSel ? "bg-foreground/5" : "active:bg-accent/60",
                              )}
                            >
                              <span
                                className={cn(
                                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                                  isSel
                                    ? "border-emerald-400/70"
                                    : "border-muted-foreground/40",
                                )}
                                aria-hidden
                              >
                                {isSel && (
                                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  {child.name}
                                </span>
                                {child.endpoint && (
                                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                    {child.endpoint.host}:{child.endpoint.port}
                                  </span>
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : block.entries.length === 0 ? (
                  <p className="px-3.5 py-3 text-xs text-muted-foreground">
                    No servers loaded
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {block.entries.map((entry) => {
                      const profile = entry.profile;
                      const supported = isSupported(profile);
                      const { code } = flagForProfile({
                        tag: supported ? profile.tag : undefined,
                        server: supported ? profile.server : undefined,
                        geoipByIp,
                      });
                      return (
                        <li key={`home-server-${entry.profileIndex}`}>
                          <button
                            type="button"
                            onClick={() => supported && onSelect(entry.profileIndex)}
                            disabled={!supported}
                            className={cn(
                              "flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors",
                              entry.selected ? "bg-foreground/5" : "active:bg-accent/60",
                              !supported && "cursor-not-allowed opacity-50",
                            )}
                          >
                            <span
                              className={cn(
                                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                                entry.selected
                                  ? "border-emerald-400/70"
                                  : "border-muted-foreground/40",
                              )}
                              aria-hidden
                            >
                              {entry.selected && (
                                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                              )}
                            </span>
                            <FlagIcon code={code} size={18} className="shrink-0" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {profileLabel(profile)}
                              </span>
                              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                {supported ? profileEndpoint(profile) : "unsupported link"}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )
              )}
            </SectionCard>
          );
        })}
      </div>

    </div>
  );
}

