import { AtlasGlobe } from "./atlas/AtlasGlobe";
import { HomeTraffic } from "./SpeedTestTab";
import { sameProfileRef } from "@/lib/connectionHealth";
import { describeRoutingMode } from "@/lib/routingMode";
import {RecoveryNotice} from "@/components/RecoverySettings";
import {ProfileHealthBadge} from "@/components/ProfileHealthBadge";
import {profileRef} from "@/lib/profileEvidence";
import type {ReactNode} from "react";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { presentConnection } from "@/lib/connectionPresentation";
import type { DesktopHealthSnapshot, SessionIdentity } from "@/lib/connectionHealth";
import { connectionProfileStorageKey } from "@/lib/lastServer";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Globe,
  Layers,
  Link2,
  Loader2,
  Plus,
  Power,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/Button";
import { ConnectionErrorCard } from "@/components/ConnectionErrorCard";
import { Card } from "@/components/Card";
import { FlagIcon } from "@/components/FlagIcon";
import { useTrafficStream } from "@/hooks/useTrafficStream";
import { useSessionTimer } from "@/hooks/useSessionTimer";
import { latencyToBars, useServerLatency } from "@/hooks/useServerLatency";
import { cn } from "@/lib/utils";
import { flagForProfile } from "@/lib/flags";
import { profileLabel, profileEndpoint, isSupported } from "@/lib/outbound";
import { isValidProfileSelection } from "@/lib/profileSelection";
import { loadExpandedSubscriptions, saveExpandedSubscriptions } from "@/lib/expandedSubscriptions";
import { useI18n } from "@/lib/i18n";
import type { GeneratorSettings, HomeProfileMetadata, Outbound, RoutingOptions, Status, StatusReport, TunnelMode } from "@/lib/types";
import type { ConnectionProfile } from "@/lib/connectionProfiles";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface HomeTabProps {
  status: StatusReport;
  errorActions?:ReactNode;
  runtimeActions?:ReactNode;
  diagnostics?: DesktopHealthSnapshot|null;
  onRetryHealth?: (expected:SessionIdentity)=>Promise<void>;
  healthActionBusy?:boolean;
  healthActionMessage?:string|null;
  statusLabel: Status;
  busy: boolean;
  error: string | null;
  onDismissError?: () => void;
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
  onAddLinks?: (text: string) => Promise<boolean>;
  settings?: GeneratorSettings;
  onSettingsChange?: (settings: GeneratorSettings) => void;
  onReconnect?: (overrideSettings?: GeneratorSettings) => Promise<boolean>;
}

export function HomeTab({
  status,errorActions,runtimeActions,
  diagnostics=null,onRetryHealth,healthActionBusy=false,healthActionMessage,
  statusLabel,
  busy,
  error,
  onDismissError,
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
  settings,
  onSettingsChange,
  onReconnect,
}: HomeTabProps) {
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddText, setQuickAddText] = useState("");

  const currentMode: TunnelMode = settings?.tunnel_mode ?? "tun";
  const handleModeChange = async (newMode: TunnelMode) => {
    if (newMode === currentMode || !settings) return;
    const next = { ...settings, tunnel_mode: newMode };
    onSettingsChange?.(next);
    if (statusLabel === "running" && onReconnect) {
      await onReconnect(next);
    }
  };

  const isRunning = statusLabel === "running";
  const isTransition = statusLabel === "starting" || statusLabel === "stopping";
  const sessionTimer = useSessionTimer(isRunning);
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
  const { t, locale } = useI18n();

  const healthView=presentConnection(status,diagnostics,Date.now());
  const headline = (() => {
    if (statusLabel === "running") return t("health.running");
    if (statusLabel === "starting") return t("common.connecting");
    if (statusLabel === "stopping") return t("common.stopping");
    if (healthView.state === "crashed") return t("health.crashed");
    return t("common.disconnected");
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
  const activeName = status.profile_name || (activeIsAuto
    ? "Auto (urltest)"
    : activeOutbound ?? null);

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

  const display = (profile: ConnectionProfile) => connectionProfileDisplay(profile, readyProfileMetadata, geoipByIp, latency.byTag);
  const countryOf = (profile: ConnectionProfile) => {
    const row=display(profile);
    const code=row.code === "??" ? flagForProfile({tag:row.label,geoipByIp}).code : row.code;
    return /^[A-Z]{2}$/.test(code) ? code : null;
  };
  const countries=[...new Set(profiles.map(countryOf).filter(Boolean))].sort().join(" ");
  const sessionRef=diagnostics?.session?.profile_ref;
  const owner=sessionRef && profiles.find(p=>{const ref=profileRef(p);return ref && sameProfileRef(ref,sessionRef);});
  const liveProfile=activeProfile || owner || activeXrayProfile;
  const country=liveProfile ? countryOf(liveProfile) : activeFlag?.code !== "??" ? activeFlag?.code ?? null : null;
  const regionNames=useMemo(()=>new Intl.DisplayNames([locale],{type:"region"}),[locale]);
  const route=settings ? describeRoutingMode(settings,"desktop",selected?.kind==="ready_config"?selected.engine:"singbox") : null;
  const [recent, setRecent]=useState<string[]>(()=>{
    try {const value=JSON.parse(localStorage.getItem("cloakwire.desktop.recentProfiles") || "[]");
      return Array.isArray(value)?value.filter((id:unknown)=>typeof id==="string").slice(0,3):[];}catch{return [];}
  });
  const selectedKey=selected && connectionProfileStorageKey(selected);
  useEffect(()=>{
    if(!selectedKey)return;
    setRecent(previous=>{
      if(previous[0]===selectedKey)return previous;
      const next=[selectedKey,...previous.filter(k=>k!==selectedKey)].slice(0,3);
      try{localStorage.setItem("cloakwire.desktop.recentProfiles",JSON.stringify(next));}catch{}
      return next;
    });
  },[selectedKey]);
  const recentRows=recent.map(key=>profiles.findIndex(p=>connectionProfileStorageKey(p)===key)).filter(i=>i>=0);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-5">
      <section className="atlas-hero">
        <AtlasGlobe countries={countries} country={country} running={isRunning} bytesPerSecond={(current?.down_bps??0)+(current?.up_bps??0)}/>
        <div className="space-y-2 min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className={cn("h-2 w-2 rounded-full",isRunning?"bg-theme-accent":"bg-muted-foreground")}/><h1 className="font-medium">{headline}</h1>
            {isRunning && <span className="ml-auto tabular-nums">{sessionTimer.formatted}</span>}
          </div>
          <h2 className="text-2xl font-semibold">{isRunning ? country ? regionNames.of(country) : t("atlas.unknown") : t("atlas.pick")}</h2>
          {isRunning && <p className="text-xs text-muted-foreground">{activeName || (isXrayRunning ? activeXrayDisplay.label : "")}{userPicked && " · "+t("home.picked",{name:userPicked})}</p>}
          <ServerPicker profiles={profiles} selectedIndex={selectedIndex} latencyByTag={latency.byTag}
            readyProfileMetadata={readyProfileMetadata} subscriptionNames={subscriptionNames} geoipByIp={geoipByIp} onSelect={onSelect}/>
          {recentRows.length>0 && <div className="atlas-recent">
            <h2 className="text-xs text-muted-foreground">{t("atlas.recent")}</h2>
            {recentRows.map(index=><ProfileChoice key={connectionProfileStorageKey(profiles[index]) || index} row={{index,profile:profiles[index]}} selectedIndex={selectedIndex}
              readyProfileMetadata={readyProfileMetadata} geoipByIp={geoipByIp} latencyByTag={latency.byTag} onSelect={onSelect} compact />)}
          </div>}
          <div className="flex items-center gap-2">
            <Button onClick={isRunning?onDisconnect:onConnect} disabled={busy || isTransition || (!isRunning && !canStart)}
              aria-label={isRunning ? "Disconnect":"Connect"} className={cn("gap-2",powerButtonClasses(statusLabel))}>
              {isTransition?<Loader2 size={16} className="animate-spin"/>:<Power size={16}/>}
              {t(isRunning?"common.disconnect":"common.connect")}
            </Button>
            {!profiles.length && <button type="button" className="text-sm text-theme-accent" onClick={()=>setQuickAddOpen(true)}>{t("servers.addServer")}</button>}
          </div>
        </div>
      </section>
      <section className="atlas-route-summary bento-card rounded-xl">
        <div className="min-w-0"><h2 className="text-sm font-semibold">{t("routingModes.title")}</h2>
          <p className="text-xs text-muted-foreground">{route && t("routingModes."+(route.reason || route.mode))}</p>
          <div className="flex flex-wrap gap-x-3 text-xs">
            {vpnProcesses.map(name=><span key={"vpn"+name}>{name} · VPN</span>)}
            {directProcesses.map(name=><span key={"direct"+name}>{name} · {t("home.directBadge")}</span>)}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={()=>onNavigateTab?.("routing")}>{t("common.edit")}</Button>
      </section>
      {(isRunning||healthView.issue)&&<ConnectionStatus view={healthView} showHeading={false}
        onRetry={healthView.session&&onRetryHealth?()=>{void onRetryHealth(healthView.session!);}:undefined}
        onChooseServer={onNavigateTab?()=>onNavigateTab("servers"):undefined} busy={healthActionBusy} message={healthActionMessage} actions={runtimeActions}/>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-background/60 p-0.5 shadow-sm">
                <button
                  type="button"
                  onClick={() => handleModeChange("tun")}
                  disabled={busy || isTransition}
                  title="TUN"
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all",
                    currentMode === "tun"
                      ? "bg-theme-subtle text-theme-accent border border-theme-accent-subtle shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5",
                  )}
                >
                  <ShieldCheck className="h-3 w-3" />
                  <span>TUN</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleModeChange("system_proxy")}
                  disabled={busy || isTransition}
                  title={t("home.systemProxy")}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all",
                    currentMode === "system_proxy"
                      ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5",
                  )}
                >
                  <Globe className="h-3 w-3" />
                  <span>{t("common.proxy")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleModeChange("both")}
                  disabled={busy || isTransition}
                  title={t("common.both")}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all",
                    currentMode === "both"
                      ? "bg-purple-500/20 text-purple-300 border border-purple-500/30 shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5",
                  )}
                >
                  <Layers className="h-3 w-3" />
                  <span>{t("common.both")}</span>
                </button>
              </div>
        <span className="text-xs text-muted-foreground">{status.engine==="xray"?"Xray":"sing-box"}</span>
      </div>
      <HomeTraffic key={[status.run_id,status.status,selectedKey].join(":")} samples={trafficLive.samples} current={current} vpnActive={isRunning} activeProfileName={activeName}/>
      <RecoveryNotice />
      {error && <ConnectionErrorCard key={error} error={error} onDismiss={onDismissError} actions={errorActions} />}

      {/* All-servers strip — quick visual switcher. */}
      {profiles.length > 0 && (
        <Card className="bento-card p-4">
          <div className="mb-3 flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              <Server className="h-3.5 w-3.5 text-theme-accent" />
              {t("servers.all")} ({profiles.length})
            </div>
            <button
              type="button"
              onClick={() => setQuickAddOpen(true)}
              className="flex items-center gap-1 rounded-lg border border-theme-accent-subtle bg-theme-subtle px-2.5 py-1 text-xs font-medium text-theme-accent hover:bg-theme-subtle/80 transition shadow-sm"
              title={t("servers.addServer")}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t("common.add")}</span>
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
                <div className="rounded-xl border border-theme-accent-subtle bg-theme-subtle p-2 text-theme-accent">
                  <Link2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    {t("servers.addServer")}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t("servers.subscriptionUrl")}
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
              className="min-h-[120px] w-full resize-y rounded-xl border border-border/80 bg-[#07080c] px-3.5 py-2.5 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/40 focus:border-theme-accent focus:outline-none focus:ring-1 focus:ring-theme-accent"
              spellCheck={false}
              autoFocus
            />

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setQuickAddOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={!quickAddText.trim()}
                onClick={async () => {
                  if (quickAddText.trim()) {
                    if (!await onAddLinks?.(quickAddText.trim())) return;
                    setQuickAddText("");
                    setQuickAddOpen(false);
                  }
                }}
                className="bg-theme-accent hover:opacity-90 text-zinc-950 font-medium px-4"
              >
                {t("common.add")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function powerButtonClasses(statusLabel: Status): string {
  if (statusLabel === "running") {
    return "border-theme-accent bg-success text-zinc-950";
  }
  if (statusLabel === "starting" || statusLabel === "stopping") {
    return "border-foreground/20 bg-foreground/5";
  }
  return "border-theme-accent bg-theme-accent text-zinc-950";
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
            ? "bg-theme-subtle text-theme-accent border border-theme-accent-subtle font-medium"
            : "border-theme-accent bg-theme-subtle text-theme-accent font-medium"
          : compact
            ? "hover:bg-secondary/80 text-foreground"
            : "hover:border-border text-foreground",
      )}
    >
      <FlagIcon code={display.code} size={compact ? 16 : 14} className="shrink-0 self-center" />
      <span className="min-w-0 flex-1 font-medium"><span className="block truncate">{display.label}</span><ProfileHealthBadge profileRef={profileRef(row.profile)}/></span>
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
  const { t } = useI18n();
  const grouped = groupHomeProfiles(profiles);
  // Default to collapsed unless explicitly expanded by the user; persisted across tab switches
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    loadExpandedSubscriptions(false),
  );

  const toggleGroup = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpandedSubscriptions(next, false);
      return next;
    });
  };

  const renderRows = (rows: IndexedHomeProfile[]) => rows.map((row) => (
    <li className="list-none" key={connectionProfileStorageKey(row.profile) ?? row.index}>
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
          <div className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t("servers.manualServers")}</div>
          {mode === "grid" ? (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {grouped.manual.map((row) => (
                <ProfileChoice key={connectionProfileStorageKey(row.profile) ?? row.index} row={row} selectedIndex={selectedIndex} readyProfileMetadata={readyProfileMetadata} geoipByIp={geoipByIp} latencyByTag={latencyByTag} onSelect={onSelect} onSelectionDone={onSelectionDone} compact={false} />
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
                toggleGroup(group.id);
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
                  <ProfileChoice key={connectionProfileStorageKey(row.profile) ?? row.index} row={row} selectedIndex={selectedIndex} readyProfileMetadata={readyProfileMetadata} geoipByIp={geoipByIp} latencyByTag={latencyByTag} onSelect={onSelect} onSelectionDone={onSelectionDone} compact={false} />
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
  const { t } = useI18n();
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
  const selectedFlag = selectedDisplay ?? { flag: "🌐", code: "??", label: t("servers.noServers"), ms: undefined, key: "none", protocol: "" };
  const selectedName = selectedDisplay?.label ?? t("servers.noServers");
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
                    ? "bg-theme-subtle text-theme-accent border border-theme-accent-subtle font-medium"
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
                  {t("servers.autoBestLatency")}
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
