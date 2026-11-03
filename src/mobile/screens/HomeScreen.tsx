import { ConnectionControl } from "@/components/atlas/ConnectionControl";
import { sameProfileRef, type ProfileRef } from "@/lib/connectionHealth";
import { Button } from "@/components/Button";
import { AtlasGlobe } from "@/components/atlas/AtlasGlobe";
import { HomeTraffic } from "@/components/SpeedTestTab";
import {RecoveryNotice} from "@/components/RecoverySettings";
import {ProfileHealthBadge} from "@/components/ProfileHealthBadge";
import type {ReactNode} from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Globe,
  ChevronDown,
  Plus,
  Server,
  Shield,
} from "lucide-react";
import { formatDuration } from "@/hooks/useSessionTimer";
import { FlagIcon } from "@/components/FlagIcon";
import { ConnectionErrorCard } from "@/components/ConnectionErrorCard";
import { useTrafficStream } from "@/hooks/useTrafficStream";
import { useServerLatency } from "@/hooks/useServerLatency";
import { api } from "@/lib/api";
import { flagForProfile } from "@/lib/flags";
import { isSupported, profileEndpoint, profileLabel } from "@/lib/outbound";
import { cn } from "@/lib/utils";
import type { ChildProfileSummary, GeneratorSettings, Outbound, Subscription } from "@/lib/types";
import { loadExpandedSubscriptions, saveExpandedSubscriptions } from "@/lib/expandedSubscriptions";
import type { ServerGroup } from "../lib/serverGrouping";
import { buildHomeServerCatalog } from "../lib/homeServerCatalog";
import type { VpnConnection } from "../useVpnConnection";
import { summarizeRoutingPolicy } from "../lib/mobileUi";
import { AddSubscriptionSheet } from "../components/AddSubscriptionSheet";
import { Sheet } from "../components/Sheet";
import { formatMs } from "../lib/format";
import { triggerHaptic } from "../lib/haptics";
import { useI18n } from "@/lib/i18n";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function HomeScreen({
  vpn,errorActions,probeCard,selectedRef,
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
  errorActions?:ReactNode;
  probeCard?:ReactNode;
  selectedRef?: ProfileRef | null;
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
  onAddLinks?: (outbounds: Outbound[]) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);

  const connectionError = vpn.error ?? (vpn.state === "error" ? vpn.message : null);
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
      ? t("common.connected")
      : vpn.state === "starting"
        ? t("common.connecting")
        : vpn.state === "error"
          ? t("common.error")
          : t("common.disconnected");

  const serverLine = activeBundle
    ? activeBundle.childName
    : !selectedSupported
      ? "Auto (best latency)"
      : profileLabel(selectedSupported);

  const connectedName = vpn.profileName?.trim() || (vpn.engine === "xray" ? "Xray" : "sing-box");
  const differentOwner = !!(vpn.source && selectedRef && !sameProfileRef(vpn.source.profile_ref, selectedRef));
  const actualName = vpn.profileName?.trim();
  const showActive = isRunning && (differentOwner || (actualName && actualName !== serverLine));

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
        result.push({ type: "manual", id: group.id, label: t("atlas.customProfiles"), entries: group.entries });
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
  }, [serverCatalog, subs, t]);

  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() =>
    loadExpandedSubscriptions(true),
  );

  const toggleBlock = (id: string) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpandedSubscriptions(next, true);
      return next;
    });
  };

  const totalServersCount = useMemo(() => {
    return blocks.reduce((acc, b) => acc + (b.type === "bundle" ? b.children.length : b.entries.length), 0);
  }, [blocks]);

  const locations = useMemo(() => {
    const rows = new Map<string, { name: string; country: string; index?: number; bundle?: {subscriptionId:string;childKey:string;engine:"singbox"|"xray";childName:string} }>();
    for (const block of blocks) {
      if (block.type === "bundle") {
        for (const child of block.children) {
          rows.set(JSON.stringify(["bundle",block.id,child.key]), {
            name:child.name, country:flagForProfile({tag:child.name,server:child.endpoint?.host,geoipByIp}).code,
            bundle:{subscriptionId:block.id,childKey:child.key,engine:child.engine,childName:child.name}
          });
        }
      } else {
        for (const entry of block.entries) {
          const p=entry.profile;
          if (!isSupported(p)) continue;
          const key=JSON.stringify([block.id,entry.manualId ?? p.tag]);
          rows.set(key,{name:profileLabel(p),country:flagForProfile({tag:p.tag,server:p.server,geoipByIp}).code,index:entry.profileIndex});
        }
      }
    }
    return rows;
  },[blocks,geoipByIp]);
  const pickedKey=activeBundle ? JSON.stringify(["bundle",activeBundle.subscriptionId,activeBundle.childKey]) :
    [...locations].find(([,row])=>row.index===selectedIndex)?.[0];
  const [recent,setRecent]=useState<string[]>(()=>{
    try {const ids=JSON.parse(localStorage.getItem("cloakwire.mobile.atlasRecent") || "[]");return Array.isArray(ids)?ids.filter((id:unknown)=>typeof id==="string").slice(0,3):[];}catch{return [];}
  });
  useEffect(()=>{
    if(!pickedKey)return;
    setRecent(previous => {
      if(previous[0]===pickedKey)return previous;
      const next=[pickedKey,...previous.filter(id=>id!==pickedKey)].slice(0,3);
      try{localStorage.setItem("cloakwire.mobile.atlasRecent",JSON.stringify(next));}catch{}
      return next;
    });
  },[pickedKey]);
  const countries=[...new Set([...locations.values()].map(r=>r.country).filter(c=>/^[A-Z]{2}$/.test(c)))].sort().join(" ");
  const matches=[...locations.values()].filter(row=>row.name===connectedName);
  const knownCountries=new Set(matches.map(row=>row.country));
  const code=knownCountries.size===1 ? matches[0].country : flagForProfile({tag:connectedName,geoipByIp}).code;
  const pickedCountry = activeBundle ? locations.get(pickedKey ?? "")?.country : flag?.code;
  const recentRows=recent.filter(key=>key!==pickedKey && locations.has(key));
  return (
    <div className="flex flex-col gap-3 p-4 pb-8">
      <AtlasGlobe countries={countries} running={isRunning} country={/^[A-Z]{2}$/.test(code)?code:null} bytesPerSecond={(current?.down_bps??0)+(current?.up_bps??0)} />
      <div className="atlas-panel atlas-connection-panel relative flex min-w-0 flex-col gap-2 overflow-clip p-4">
        {/* Top Active Server Selector Pill */}
        <div className="relative z-10 flex w-full items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setServerPickerOpen(true)}
            className="atlas-server-trigger"
          >
            {pickedCountry && /^[A-Z]{2}$/.test(pickedCountry) ? (
              <FlagIcon code={pickedCountry} size={15} className="shrink-0" />
            ) : (
              <Globe size={15} aria-hidden="true"/>
            )}
            <span className="truncate font-medium text-foreground">{serverLine}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>

        </div>
        <ConnectionControl headline={headline} running={isRunning} transition={isTransition}
          duration={uptimeSecs == null ? null : formatDuration(uptimeSecs)} disabled={vpn.busy || isTransition || !vpn.ready}
          onToggle={() => { triggerHaptic("medium"); if (isRunning) void vpn.disconnect(); else void onConnect(); }} />
        {showActive && <p className="atlas-active-note">
          {actualName && actualName !== serverLine ? t("home.via")+" "+actualName : t("atlas.otherActive")}
        </p>}
        {!activeBundle && !profiles.length && <Button variant="outline" size="sm" onClick={onAddSub && onAddLinks ? () => setAddSheetOpen(true) : onOpenServers}>{t("servers.addServer")}</Button>}
        {probeCard}
        {connectionError && <ConnectionErrorCard key={connectionError} error={connectionError} onDismiss={vpn.clearError} actions={errorActions} />}
        {recentRows.length>0 && <div><h2 className="text-xs text-muted-foreground">{t("atlas.recent")}</h2>
          <div className="divide-y divide-border">{recentRows.map(key=>{
            const row=locations.get(key)!;
            return <button type="button" key={key} aria-pressed={key===pickedKey}
              className="atlas-pick-row" onClick={()=>{
                triggerHaptic("selection");
                if(row.bundle)void onSelectBundleChild(row.bundle);else if(row.index!=null)onSelect(row.index);
              }}><FlagIcon code={row.country} size={15}/><span className="min-w-0 truncate">{row.name}</span></button>;
          })}</div>
        </div>}
        <details className="atlas-session-details">
          <summary>{t("profileProbe.details")}</summary>
          <span>{t("home.tunMode")} · {vpn.engine === "xray" ? "Xray" : "sing-box"}</span>
        </details>
      </div>
      <RecoveryNotice />

      {/* ─── Bento 3: Per-App Routing Summary ─────────────────────── */}
      <div className="atlas-panel atlas-home-section flex flex-col justify-between p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Shield className="h-3.5 w-3.5 text-theme-accent" />
            {t("home.perAppRouting")}
          </div>
          <Button size="sm" variant="ghost"
            type="button"
            onClick={onOpenRouting}
          >
            {t("home.manageRouting")}
          </Button>
        </div>
        <button
          type="button"
          onClick={onOpenRouting}
          className="mt-1.5 text-left active:opacity-80"
        >
          <p className="text-xs text-muted-foreground leading-relaxed" title={routingSummary}>
            {routingSummary}
          </p>
          {!!settings.routing.tun_app_list?.length && <span className="break-all text-xs text-muted-foreground">{settings.routing.tun_app_list.join(" · ")}</span>}
        </button>
      </div>

      <HomeTraffic key={JSON.stringify([vpn.since,vpn.state,pickedKey])} samples={traffic.samples} current={current}
        vpnActive={isRunning} activeProfileName={isRunning?connectedName:null}/>

      {/* ─── Bento 4: All Servers List & Quick Add ────────────────── */}
      <div className="atlas-panel atlas-home-section flex flex-col p-4">
        <div className="mb-2 flex items-center justify-between px-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Server className="h-3.5 w-3.5 text-theme-accent" />
            <span>All Servers</span>
            <span className="atlas-count">
              {totalServersCount}
            </span>
          </div>
          <Button size="sm" variant="outline"
            type="button"
            onClick={() => setAddSheetOpen(true)}

            title="Add server or subscription"
          >
            <Plus className="h-3.5 w-3.5 stroke-[2.5]" />
            <span>Add</span>
          </Button>
        </div>

        <div className="divide-y divide-border">
          {blocks.map((block) => {
            const isExpanded = block.type === "manual" || expandedBlocks.has(block.id);
            return (
              <div key={block.id} className="py-1">
                {block.type === "manual" ? (
                  block.entries.length > 1 && (
                    <div className="px-1 py-2 text-[11px] text-muted-foreground/70">
                      {block.label} ({block.entries.length})
                    </div>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleBlock(block.id)}
                    aria-expanded={isExpanded}
                    className="flex w-full items-center justify-between px-1 py-2.5 text-left transition active:opacity-80"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {block.label}
                      </span>
                      <span className="shrink-0 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {block.type === "bundle" ? block.children.length : block.entries.length}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                        !isExpanded && "-rotate-90",
                      )}
                    />
                  </button>
                )}

                {isExpanded && (
                  block.type === "bundle" ? (
                    block.children.length === 0 ? (
                      <p className="px-1 py-2 text-xs text-muted-foreground">
                        {t("servers.noServersLoaded")}
                      </p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {block.children.map((child) => {
                          const isSel =
                            !!activeBundle &&
                            activeBundle.subscriptionId === block.id &&
                            activeBundle.childKey === child.key;
                          const latency = childLatency.get(`${block.id}:${child.key}`);
                          return (
                            <li key={`home-bundle-${block.id}-${child.key}`}>
                              <button aria-pressed={isSel}
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
                                className="atlas-pick-row"
                              >
                                <span
                                  className={cn(
                                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition",
                                    isSel
                                      ? "border-theme-accent bg-theme-subtle"
                                      : "border-white/20",
                                  )}
                                >
                                  {isSel && <span className="h-1.5 w-1.5 rounded-full bg-theme-accent" />}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-foreground">
                                    {child.name}
                                  </span>
                                  {child.endpoint && (
                                    <span className="block truncate text-[11px] text-muted-foreground/80">
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
                      {t("servers.noServersLoaded")}
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
                        const ep = supported ? profileEndpoint(profile) : null;
                        const latency = supported ? latencyState.byTag.get(profile.tag) : undefined;
                        return (
                          <li key={entry.manualId ?? `home-server-${entry.profileIndex}`}>
                            <button aria-pressed={entry.selected}
                              type="button"
                              onClick={() => {
                                if (supported) {
                                  triggerHaptic("selection");
                                  onSelect(entry.profileIndex);
                                }
                              }}
                              disabled={!supported}
                              className="atlas-pick-row"
                            >
                              <span
                                className={cn(
                                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition",
                                  entry.selected
                                    ? "border-theme-accent bg-theme-subtle"
                                    : "border-white/20",
                                )}
                              >
                                {entry.selected && <span className="h-1.5 w-1.5 rounded-full bg-theme-accent" />}
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
                                <ProfileHealthBadge profileIndex={entry.profileIndex}/>
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
        title={t("home.selectServer")}
      >
        <div className="space-y-3 pb-4">
          <button aria-pressed={selectedIndex === -1}
            type="button"
            onClick={() => {
              onSelect(-1);
              setServerPickerOpen(false);
            }}
            className="atlas-pick-row"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs">
              ∞
            </span>
            <div className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Auto (best latency)</span>
              <span className="block text-[11px] text-muted-foreground">urltest</span>
            </div>
          </button>

          {blocks.map((block) => (
            <div key={`sheet-block-${block.id}`} className="space-y-1.5 pt-1">
              <p className="px-1 text-[11px] text-muted-foreground">
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
                      <button aria-pressed={isSel}
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
                        className="atlas-pick-row"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{child.name}</span>
                        <LatencyBadge ms={latency} />
                        <span className="text-[10px] text-muted-foreground/70">{child.engine}</span>
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
                      <button aria-pressed={entry.selected}
                        key={entry.manualId ?? `sheet-entry-${entry.profileIndex}`}
                        type="button"
                        onClick={() => {
                          if (supported) {
                            triggerHaptic("selection");
                            onSelect(entry.profileIndex);
                            setServerPickerOpen(false);
                          }
                        }}
                        disabled={!supported}
                        className="atlas-pick-row"
                      >
                        {code ? (
                          <FlagIcon code={code} size={16} className="shrink-0" />
                        ) : (
                          <span className="text-sm">🌐</span>
                        )}
                        <span className="min-w-0 flex-1 text-sm font-medium"><span className="block truncate">{profileLabel(profile)}</span><ProfileHealthBadge profileIndex={entry.profileIndex}/></span>
                        <LatencyBadge ms={latency} />
                        <span className="text-[10px] text-muted-foreground/70">{profile.protocol}</span>
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
function LatencyBadge({ ms }: { ms: number | undefined }) {
  if (ms == null) return null;
  const tone = ms < 250 ? "fast" : ms < 700 ? "medium" : "slow";
  const toneClass =
    tone === "fast"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : tone === "medium"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] tabular-nums shrink-0",
        toneClass,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {formatMs(ms)}
    </span>
  );
}
