import { ServerCheck } from "./ServerCheck";
import { ServerLatency } from "./ServerLatency";
import { ConnectionControl } from "./atlas/ConnectionControl";
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
import type { DesktopHealthSnapshot } from "@/lib/connectionHealth";
import { connectionProfileStorageKey } from "@/lib/lastServer";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Globe,
  Layers,
  Plus,
  Server,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/Button";
import { ConnectionErrorCard } from "@/components/ConnectionErrorCard";
import { Card } from "@/components/Card";
import { FlagIcon } from "@/components/FlagIcon";
import { useTrafficStream } from "@/hooks/useTrafficStream";
import { useSessionTimer } from "@/hooks/useSessionTimer";
import { useServerLatency } from "@/hooks/useServerLatency";
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
  statusLabel: Status;
  busy: boolean;
  error: string | null;
  onDismissError?: () => void;
  canStart: boolean;
  configName: string | null;
  recent?: readonly string[];
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
  onOpenImport?: () => void;
  settings?: GeneratorSettings;
  onSettingsChange?: (settings: GeneratorSettings) => void;
  onReconnect?: (overrideSettings?: GeneratorSettings) => Promise<boolean>;
}

export function HomeTab({
  status,errorActions,runtimeActions,
  diagnostics=null,
  statusLabel,
  busy,
  error,
  onDismissError,
  canStart,
  configName: _configName,
  recent = [],
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
  onOpenImport,
  settings,
  onSettingsChange,
  onReconnect,
}: HomeTabProps) {

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

  const vpnProcesses = routingOptions?.vpn_processes ?? [];
  const directProcesses = routingOptions?.direct_processes ?? [];

  const display = (profile: ConnectionProfile) => connectionProfileDisplay(profile, readyProfileMetadata, geoipByIp, latency.byTag);
  const countryOf = (profile: ConnectionProfile) => {
    const row=display(profile);
    const code=row.code === "??" ? flagForProfile({tag:row.label,geoipByIp}).code : row.code;
    return /^[A-Z]{2}$/.test(code) ? code : null;
  };
  const countries=[...new Set(profiles.map(countryOf).filter(Boolean))].sort().join(" ");
  const sessionRef=healthView.session?.profile_ref;
  const owner=sessionRef && profiles.find(p=>{const ref=profileRef(p);return ref && sameProfileRef(ref,sessionRef);});
  const liveProfile=activeProfile || owner || activeXrayProfile;
  const country=liveProfile ? countryOf(liveProfile) : activeFlag?.code !== "??" ? activeFlag?.code ?? null : null;
  const regionNames=useMemo(()=>new Intl.DisplayNames([locale],{type:"region"}),[locale]);
  const route=settings ? describeRoutingMode(settings,"desktop",selected?.kind==="ready_config"?selected.engine:"singbox") : null;
  const selectedKey=selected && connectionProfileStorageKey(selected);
  const pickedName = selected && display(selected).label;
  const pickedRef = selected && profileRef(selected);
  const sessionName = activeName || healthView.session?.display_name || (isXrayRunning ? activeXrayDisplay.label : null);
  const differentOwner = !!(sessionRef && pickedRef && !sameProfileRef(sessionRef, pickedRef));
  const showActive = isRunning && sessionName && (sessionName !== pickedName || differentOwner);
  const recentRows=recent.map(key=>profiles.findIndex(p=>connectionProfileStorageKey(p)===key)).filter(i=>i>=0);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-5">
      <section className="atlas-hero">
        <AtlasGlobe countries={countries} country={country} running={isRunning} bytesPerSecond={(current?.down_bps??0)+(current?.up_bps??0)}/>
        <div className="space-y-2 min-w-0">
          {isRunning && <h2 className="text-xl font-semibold">{country ? regionNames.of(country) : t("atlas.unknown")}</h2>}
          <ServerPicker profiles={profiles} selectedIndex={selectedIndex} latencyByTag={latency.byTag}
            readyProfileMetadata={readyProfileMetadata} subscriptionNames={subscriptionNames} geoipByIp={geoipByIp} onSelect={onSelect}/>
          <ConnectionControl running={isRunning} transition={isTransition}
            duration={sessionTimer.formatted} disabled={busy || isTransition || (!isRunning && !canStart)}
            onToggle={isRunning ? onDisconnect : onConnect} />
          <div className="flex items-center justify-between gap-2">
            <div className="atlas-mode-selector atlas-home-modes">
                    <button aria-pressed={currentMode === "tun"}
                      type="button"
                      onClick={() => handleModeChange("tun")}
                      disabled={busy || isTransition}
                      title="TUN"
                      className="atlas-choice"
                    >
                      <ShieldCheck className="h-3 w-3" />
                      <span>TUN</span>
                    </button>
                    <button aria-pressed={currentMode === "system_proxy"}
                      type="button"
                      onClick={() => handleModeChange("system_proxy")}
                      disabled={busy || isTransition}
                      title={t("home.systemProxy")}
                      className="atlas-choice"
                    >
                      <Globe className="h-3 w-3" />
                      <span>{t("common.proxy")}</span>
                    </button>
                    <button aria-pressed={currentMode === "both"}
                      type="button"
                      onClick={() => handleModeChange("both")}
                      disabled={busy || isTransition}
                      title={t("common.both")}
                      className="atlas-choice"
                    >
                      <Layers className="h-3 w-3" />
                      <span>{t("common.both")}</span>
                    </button>
                  </div>
            <span className="text-xs text-muted-foreground">{status.engine==="xray"?"Xray":"sing-box"}</span>
          </div>
          {showActive && <p className="atlas-active-note">{sessionName === pickedName ? t("atlas.otherActive") : t("home.via")+" "+sessionName}</p>}
          {!profiles.length && <Button size="sm" variant="outline" onClick={onOpenImport}>{t("servers.addServer")}</Button>}
        </div>
      </section>
      {(isRunning || healthView.issue || healthView.state === "crashed") && <ConnectionStatus view={healthView} showHeading={healthView.state === "crashed"} hideSessionName={isRunning && !!healthView.session && [pickedName, sessionName].includes(healthView.session.display_name)}

        onChooseServer={onNavigateTab?()=>onNavigateTab("servers"):undefined} actions={runtimeActions}/>}
      <RecoveryNotice />
      {error && <ConnectionErrorCard key={error} error={error} onDismiss={onDismissError} actions={errorActions} />}

      {recentRows.length>0 && <section className="atlas-recent" aria-label={t("atlas.recent")}>
        <h2 className="text-xs text-muted-foreground">{t("atlas.recent")}</h2>
        {recentRows.map(index=><ProfileChoice key={connectionProfileStorageKey(profiles[index]) || index} row={{index,profile:profiles[index]}} selectedIndex={selectedIndex}
          readyProfileMetadata={readyProfileMetadata} geoipByIp={geoipByIp} latencyByTag={latency.byTag} onSelect={index => { if (index !== selectedIndex) onSelect(index); }} compact />)}
      </section>}
      <HomeTraffic key={[status.run_id,status.status,selectedKey].join(":")} samples={trafficLive.samples} current={current} vpnActive={isRunning} activeProfileName={activeName}/>
      <section className="atlas-panel atlas-route-summary">
        <div className="min-w-0"><h2 className="text-sm font-semibold">{t("routingModes.title")}</h2>
          <p className="text-xs text-muted-foreground">{route && t("routingModes."+(route.reason || route.mode))}</p>
          <div className="flex flex-wrap gap-x-3 text-xs">
            {vpnProcesses.map(name=><span key={"vpn"+name}>{name} · VPN</span>)}
            {directProcesses.map(name=><span key={"direct"+name}>{name} · {t("home.directBadge")}</span>)}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={()=>onNavigateTab?.("routing")}>{t("common.edit")}</Button>
      </section>
      {/* All-servers strip — quick visual switcher. */}
      {profiles.length > 0 && (
        <Card className="atlas-home-section p-4">
          <div className="mb-3 flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Server className="h-3.5 w-3.5 text-theme-accent" />
              {t("servers.all")} ({profiles.length})
            </div>
            <Button size="sm" variant="outline"
              type="button"
              onClick={onOpenImport}

              title={t("servers.addServer")}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t("common.add")}</span>
            </Button>
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

    </div>
  );
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
  showCheck = false,
}: {
  row: IndexedHomeProfile;
  selectedIndex: number;
  readyProfileMetadata: ReadonlyMap<string, HomeProfileMetadata>;
  geoipByIp: Record<string, string>;
  latencyByTag: Map<string, number>;
  onSelect: (index: number) => void;
  onSelectionDone?: () => void;
  compact: boolean;
  showCheck?: boolean;
}) {
  const display = connectionProfileDisplay(row.profile, readyProfileMetadata, geoipByIp, latencyByTag);
  const isSelected = row.index === selectedIndex;
  const picker = (
    <button aria-pressed={isSelected}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(row.index);
        onSelectionDone?.();
      }}
      className="atlas-pick-row"
    >
      <FlagIcon code={display.code} size={compact ? 16 : 14} className="shrink-0 self-center" />
      <span className="min-w-0 flex-1 font-medium"><span className="block truncate">{display.label}</span><ProfileHealthBadge profileRef={profileRef(row.profile)}/></span>
      {compact && <span className="text-[10px] text-muted-foreground">{display.protocol}</span>}
      <ServerLatency ms={display.ms} />
    </button>
  );
  return showCheck ? <div className="atlas-server-entry">{picker}<ServerCheck profileRef={profileRef(row.profile)} /></div> : picker;
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
          <div className="px-2 pb-1 pt-1 text-[10px] text-muted-foreground">{t("servers.manualServers")}</div>
          {mode === "grid" ? (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {grouped.manual.map((row) => (
                <ProfileChoice key={connectionProfileStorageKey(row.profile) ?? row.index} row={row} selectedIndex={selectedIndex} readyProfileMetadata={readyProfileMetadata} geoipByIp={geoipByIp} latencyByTag={latencyByTag} onSelect={onSelect} onSelectionDone={onSelectionDone} compact={false} showCheck />
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
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[10px] text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition"
              aria-expanded={isExpanded}
            >
              <ChevronDown className={cn("h-3 w-3 transition-transform", !isExpanded && "-rotate-90")} />
              <span className="min-w-0 flex-1 truncate font-medium">{subscriptionGroupLabel(group.id, subscriptionNames)}</span>
              <span className="normal-case rounded bg-background/50 px-1.5 py-0.2 text-[10px]">{group.rows.length}</span>
            </button>
            {isExpanded && (mode === "grid" ? (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 pt-1">
                {group.rows.map((row) => (
                  <ProfileChoice key={connectionProfileStorageKey(row.profile) ?? row.index} row={row} selectedIndex={selectedIndex} readyProfileMetadata={readyProfileMetadata} geoipByIp={geoipByIp} latencyByTag={latencyByTag} onSelect={onSelect} onSelectionDone={onSelectionDone} compact={false} showCheck />
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
  const selectedName = selectedDisplay?.label ?? (profiles.length ? t("health.auto") : t("servers.noServers"));
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
        className="atlas-server-trigger"
      >
        <FlagIcon code={selectedFlag.code} size={16} className="shrink-0" />
        <span className="max-w-[180px] truncate font-medium">{selectedName}</span>
        <ServerLatency ms={selectedMs} compact />
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
            "atlas-popover",
          )}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <ul className="space-y-1">
            {/* "Auto" entry */}
            <li>
              <button aria-pressed={selectedIndex === -1}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(-1);
                  setOpen(false);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="atlas-pick-row"
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
                <span className="text-[10px] text-muted-foreground">
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
