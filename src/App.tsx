import { ServerImportDialog } from "@/components/ServerImportDialog";
import {profilePreparation} from "@/lib/profilePreparations";
import {ProfileHealthContext} from "@/components/ProfileHealthBadge";
import {ProfileErrorActions} from "@/components/ProfileErrorActions";
import {useProfileErrorActions} from "@/hooks/useProfileErrorActions";
import {useSourceRevisions} from "@/hooks/useSourceRevisions";
import {activeEvidence,sourceForProfile,type ProfileSource,type ProfileEvidence} from "@/lib/profileEvidence";
import { sameSessionIdentity, type DesktopHealthSnapshot, type SessionIdentity } from "@/lib/connectionHealth";
import { useProfileImport } from "@/hooks/useProfileImport";
import { ProfileImportDialog } from "@/components/ProfileImportDialog";
import { APP_VERSION } from "@/lib/appVersion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Home,
  Link2,
  Power,
  Route,
  Settings2,
  Terminal,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import cloakwireLogo from "@/assets/cloakwire-logo.png";
import { Button } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { StatusPill } from "@/components/StatusPill";
import { TabBar, Tabs, type TabDef } from "@/components/Tabs";
import { HomeTab } from "@/components/HomeTab";
import { ServersTab } from "@/components/ServersTab";
import "@/components/atlas/atlas.css";
import "@/components/atlas/shell.css";
import "@/components/atlas/controls.css";
import { LogsTab } from "@/components/LogsTab";
import { ConfigTab } from "@/components/ConfigTab";
import { RoutingTab } from "@/components/routing/RoutingTab";
import { UpdateModal } from "@/components/UpdateModal";
import { useI18n } from "@/lib/i18n";
import { TauriCommandError, api } from "@/lib/api";
import { humanError, isProfileCheckCancelled } from "@/lib/profileCheck";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import { GEOIP_RU_URL, migrateRuleSetPresets } from "@/lib/presets";
import { useProfileSelection } from "@/hooks/useProfileSelection";
import { useManualProfiles } from "@/hooks/useManualProfiles";
import { ManualProfileStorageNotice } from "@/components/ManualProfileStorageNotice";
import { notify } from "@/lib/notifications";
import {
  buildConnectionProfiles,
  canStartManagedSelection,
  managedSelectionForProfile,
  reconnectManagedProfile,
  selectedManualOutbound,
} from "@/lib/connectionProfiles";
import {
  connectionProfileStorageKey,
  restoreDesktopSelection,
  loadLastServer,
  saveLastServer,
} from "@/lib/lastServer";
import { useSubscriptions } from "@/hooks/useSubscriptions";
import { useGeoIp } from "@/hooks/useGeoIp";
import { useReadyProfileMetadata } from "@/hooks/useReadyProfileMetadata";
import { isSupported, profileLabel } from "@/lib/outbound";
import { basename } from "@/lib/utils";
import { shouldFrontendApplySystemProxy } from "@/lib/systemProxy";
import {
  nextReconnectRequired,
  shouldReconnectAfterProfileSelection,
  shouldShowReconnectNotice,
} from "@/lib/reconnectState";
import type {
  BinaryInfo,
  CustomRule,
  CustomRuleSet,
  GeneratorSettings,
  LogLine,
  Outbound,
  ParseFailure,
  RoutingOptions,
  RoutingOptionsV1,
  SingboxVersion,
  Status,
  StatusReport,
} from "@/lib/types";

// Detect whether we're running inside the Tauri shell.
// When opened in a plain browser (e.g. `vite dev` preview) we fall
// back to mock data so the UI is still demoable.
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const TAB_KEYS = ["home", "servers", "config", "routing", "logs"] as const;
type TabId = (typeof TAB_KEYS)[number];
const DEFAULT_TAB: TabId = "home";

function readStoredTab(): TabId {
  try {
    const v = window.localStorage.getItem("singbox.tab");
    if (v && (TAB_KEYS as readonly string[]).includes(v)) {
      return v as TabId;
    }
  } catch {
    // localStorage may be unavailable in some sandboxes; fall through.
  }
  return DEFAULT_TAB;
}

const SETTINGS_KEY = "singbox-client.settings.v2";
const SETTINGS_KEY_V1 = "singbox-client.settings.v1";

// DEFAULT_SETTINGS is imported from @/lib/defaults — single source
// of truth shared with the Config tab's preview pane.

function freshId(prefix: string) {
  return prefix + "-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

/**
 * Convert v0.1.0 boolean flags to a v2 RoutingOptions.
 *
 * Each ON boolean becomes one CustomRule in the new `rules` array. If
 * the rule depends on a rule-set (bypass_cn/geoip-cn, block_ads/
 * geosite-ads, bypass_ru/geoip-ru), the corresponding Loyalsoldier
 * rule-set is added to `rule_sets` so the rule actually fires.
 */
function migrateRoutingV1ToV2(v1: RoutingOptionsV1): RoutingOptions {
  const rules: CustomRule[] = [];
  const ruleSets: CustomRuleSet[] = [];

  // 1. LAN bypass — no rule-set needed.
  if (v1.bypass_lan) {
    rules.push({
      id: freshId("r"),
      label: "Bypass LAN (migrated)",
      enabled: true,
      matchers: {
        ip_cidr: [
          "10.0.0.0/8",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "127.0.0.0/8",
          "169.254.0.0/16",
          "::1/128",
          "fc00::/7",
          "fe80::/10",
        ],
      },
      action: { kind: "route", outbound: "direct" },
    });
  }

  // 2. IPv6 reject — no rule-set.
  if (v1.reject_ipv6) {
    rules.push({
      id: freshId("r"),
      label: "Reject IPv6 (migrated)",
      enabled: true,
      matchers: { ip_version: 6 },
      action: { kind: "reject" },
    });
  }

  // 3. QUIC reject — no rule-set.
  if (v1.block_quic) {
    rules.push({
      id: freshId("r"),
      label: "Block QUIC (migrated)",
      enabled: true,
      matchers: { port_range: ["443:443"], network: ["udp"] },
      action: { kind: "reject" },
    });
  }

  // 4. CN bypass — needs geoip-cn.
  if (v1.bypass_cn) {
    if (!ruleSets.some((rs) => rs.tag === "geoip-cn")) {
      ruleSets.push({
        tag: "geoip-cn",
        type: "remote",
        format: "binary",
        url: "https://raw.githubusercontent.com/Loyalsoldier/v2ray-rules-dat/release/geoip-cn.srs",
        update_interval: "1d",
        enabled: true,
      });
    }
    rules.push({
      id: freshId("r"),
      label: "Bypass CN (migrated)",
      enabled: true,
      matchers: { rule_set: ["geoip-cn"] },
      action: { kind: "route", outbound: "direct" },
    });
  }

  // 5. RU bypass — needs geoip-ru.
  if (v1.bypass_ru) {
    if (!ruleSets.some((rs) => rs.tag === "geoip-ru")) {
      ruleSets.push({
        tag: "geoip-ru",
        type: "remote",
        format: "binary",
        url: GEOIP_RU_URL,
        update_interval: "1d",
        enabled: true,
      });
    }
    rules.push({
      id: freshId("r"),
      label: "Bypass RU (migrated)",
      enabled: true,
      matchers: { rule_set: ["geoip-ru"] },
      action: { kind: "route", outbound: "direct" },
    });
  }

  // 6. Ad blocking — needs geosite-ads.
  if (v1.block_ads) {
    if (!ruleSets.some((rs) => rs.tag === "geosite-ads")) {
      ruleSets.push({
        tag: "geosite-ads",
        type: "remote",
        format: "binary",
        url: "https://raw.githubusercontent.com/Loyalsoldier/v2ray-rules-dat/release/geosite-ads.srs",
        update_interval: "1d",
        enabled: true,
      });
    }
    rules.push({
      id: freshId("r"),
      label: "Block Ads (migrated)",
      enabled: true,
      matchers: { rule_set: ["geosite-ads"] },
      action: { kind: "reject" },
    });
  }

  return {
    rules,
    rule_sets: ruleSets,
    // `migrateRoutingV1ToV2` only knows about boolean flags → rule
    // objects. The "simple" process-picker arrays are always empty
    // after a v1 migration; users populate them on the Routing tab.
    // `final_outbound` is preserved from v1 so the migration is
    // behaviour-preserving (existing v0.1.0 users who had
    // `final_outbound: "proxy"` keep that). The post-merge migration
    // in `loadSettings` will additionally flip a stale `"direct"`
    // back to `"proxy"` for the case where the user never set it
    // explicitly but inherited the broken simple-UX default.
    vpn_processes: [],
    direct_processes: [],
    sniff: true,
    final_outbound: v1.final_outbound || "proxy",
    auto_detect_interface: true,
    default_domain_resolver: "local",
  };
}

function loadSettings(): GeneratorSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    // Try v2 first.
    const rawV2 = window.localStorage.getItem(SETTINGS_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2);
      const merged: GeneratorSettings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        kill_switch: "off",
        block_ipv6: false,
        routing: { ...DEFAULT_SETTINGS.routing, ...(parsed.routing ?? {}) },
        clash_api: { ...DEFAULT_SETTINGS.clash_api, ...(parsed.clash_api ?? {}) },
      };
      merged.routing.rule_sets = migrateRuleSetPresets(merged.routing.rule_sets);
      if (
        merged.remote_dns === "https://8.8.8.8/dns-query" ||
        merged.remote_dns === "https://dns.google/dns-query"
      ) {
        merged.remote_dns = "1.1.1.1";
      }
      // Preserve explicit/custom routing. Base-policy changes now require Apply.
      if (parsed.tunnel_mode === "system_proxy") {
        merged.tunnel_mode = "tun";
        try {
          window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        } catch { /* ignore */ }
      }
      return merged;
    }
    // Fall back to v1 (silent migration).
    const rawV1 = window.localStorage.getItem(SETTINGS_KEY_V1);
    if (rawV1) {
      try {
        const v1 = JSON.parse(rawV1) as { routing?: RoutingOptionsV1; [k: string]: unknown };
        const v1Routing: RoutingOptionsV1 = v1.routing ?? {
          bypass_lan: true,
          reject_ipv6: true,
          block_quic: false,
          block_ads: false,
          bypass_cn: false,
          bypass_ru: false,
          final_outbound: "proxy",
        };
        const migrated: GeneratorSettings = {
          ...DEFAULT_SETTINGS,
          ...v1,
          routing: migrateRoutingV1ToV2(v1Routing),
        };
        if (migrated.tunnel_mode === "system_proxy") {
          migrated.tunnel_mode = "tun";
        }
        // Persist as v2 immediately and drop v1.
        try {
          window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(migrated));
          window.localStorage.removeItem(SETTINGS_KEY_V1);
        } catch { /* ignore */ }
        return migrated;
      } catch {
        // Corrupt v1 — fall through to defaults.
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function App() {
  const { t } = useI18n();
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [binary, setBinary] = useState<BinaryInfo | null>(null);
  const [version, setVersion] = useState<SingboxVersion | null>(null);
  const [xrayVersion, setXrayVersion] = useState<string | null>(null);
  const [diagnostics,setDiagnostics]=useState<DesktopHealthSnapshot|null>(null);
  const [healthActionBusy,setHealthActionBusy]=useState(false);
  const [healthActionMessage,setHealthActionMessage]=useState<string|null>(null);
  const healthActionPending=useRef(false);
  const diagnosticsRef=useRef<DesktopHealthSnapshot|null>(null);
  diagnosticsRef.current=diagnostics;
  const refreshEpoch=useRef(0);
  const [status, setStatus] = useState<StatusReport>({
    status: "stopped" as Status,
    pid: null,
    uptime_secs: null,
    last_exit_code: null,
    last_error: null,
  });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [configPath, setConfigPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routingWarning, setRoutingWarning] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(readStoredTab);
  const workspaceMain=useRef<HTMLElement>(null);
  useEffect(()=>{workspaceMain.current?.scrollTo(0,0);},[activeTab]);
  // Tag of the outbound that the running `proxy` selector is
  // currently routing through. Comes from `GET /proxies/proxy` on
  // the clash API — refreshed alongside status in the poll loop.
  // `null` while sing-box is stopped / unreachable.
  const [activeOutbound, setActiveOutbound] = useState<string | null>(null);

  // Parsed profiles — split into manual + subscription entries
  // so subscription auto-refresh only replaces the slots owned
  // by a particular subscription.
  const manualStore = useManualProfiles();
  const { outbounds: manualProfiles, setOutbounds: setManualProfiles, records: manualRecords } = manualStore;
  const [selectionNeedsChoice, setSelectionNeedsChoice] = useState(false);
  const selectionNeedsChoiceRef = useRef(false);
  const requireSelectionChoice = useCallback((needed: boolean) => { selectionNeedsChoiceRef.current = needed; setSelectionNeedsChoice(needed); }, []);
  const [pendingLinks, setPendingLinks] = useState<string>("");
  const [parseErrors, setParseErrors] = useState<ParseFailure[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const openImport = useCallback(() => setImportOpen(true), []);
  const [parsing, setParsing] = useState(false);
  // Config-builder settings — lifted here so they survive tab
  // switches and a process restart (persisted to localStorage below).
  const [settings, setSettings] = useState<GeneratorSettings>(loadSettings);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [reconnectFailed, setReconnectFailed] = useState(false);
  const [reconnectInProgress, setReconnectInProgress] = useState(false);
  const handleSettingsChange = useCallback(
    (next: GeneratorSettings): void => {
      setSettings(next);
      setReconnectRequired((previous) =>
        nextReconnectRequired(previous, status.status === "running"),
      );
    },
    [status.status],
  );
  // Index into `profiles` (manual + subscription) for the server the
  // user has selected on the Home tab. -1 = "auto" (let urltest pick).
  const [lastServerPick] = useState(() =>
    loadLastServer() ??
    (settings.default_outbound
      ? { kind: "profile" as const, key: `manual:${settings.default_outbound}` }
      : null),
  );
  const [selectionRestoreSettled, setSelectionRestoreSettled] = useState(false);
  const selectionRestoreAttempted = useRef(false);
  const pollTimerRef = useRef<number | null>(null);

  // App-shell update check state & modal
  const [appUpdateInfo, setAppUpdateInfo] = useState<{
    version: string;
    current_version: string;
    notes: string;
  } | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function checkUpdateOnStartup() {
      try {
        const info = await api.checkAppUpdate();
        if (cancelled) return;
        if (info.available) {
          const dismissed = window.sessionStorage.getItem(`cloakwire:dismissed_update:${info.version}`);
          if (!dismissed) {
            setAppUpdateInfo(info);
            setUpdateModalOpen(true);
          }
        }
      } catch {
        // network error or no update — ignore
      }
    }
    const timer = window.setTimeout(() => {
      void checkUpdateOnStartup();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const handleUpdateApp = async () => {
    if (!appUpdateInfo) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      await api.installAppUpdate(appUpdateInfo.version);
    } catch (e) {
      const msg =
        e instanceof TauriCommandError
          ? `${e.kind}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setUpdateError(msg);
    } finally {
      setUpdateBusy(false);
    }
  };

  const handleDismissUpdate = () => {
    if (appUpdateInfo) {
      try {
        window.sessionStorage.setItem(`cloakwire:dismissed_update:${appUpdateInfo.version}`, "1");
      } catch {
        // ignore
      }
    }
    setUpdateModalOpen(false);
  };

  // Persist the settings every time they change.
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* quota exceeded or storage disabled — ignore */
    }
  }, [settings]);

  // Subscriptions.
  const subs = useSubscriptions();

  // Subscription display names are safe summaries; Home uses this map only for group labels.
  const subscriptionNames = useMemo(
    () => new Map(subs.subs.map((subscription) => [subscription.id, subscription.name])),
    [subs.subs],
  );

  // Persist tab selection across sessions.
  useEffect(() => {
    try {
      window.localStorage.setItem("singbox.tab", activeTab);
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [activeTab]);

  // Manual profiles retain their existing objects; subscription profiles are
  // safe summaries carrying opaque backend references only.
  const profiles = useMemo(
    () => buildConnectionProfiles(manualProfiles, subs.snapshot, manualRecords),
    [manualProfiles, subs.snapshot, manualRecords],
  );
  const manualRevisions = useSourceRevisions(manualProfiles);
  const profileSources = profiles.map((profile,index)=>sourceForProfile(profile,manualRevisions[index]));
  const [attemptEvidence,setAttemptEvidence]=useState<ProfileEvidence|null>(null);
  const contextKey=String(status.run_id??"stopped")+":"+JSON.stringify(diagnostics?.session??null);
  const connectionContext=useRef(contextKey);connectionContext.current=contextKey;
  const [errorContext,setErrorContext]=useState<string|null>(null);
  const [actionError,setActionError]=useState<string|null>(null);
  const [errorSource,setErrorSource]=useState<ProfileSource|null>(null);
  const profileKeys = useMemo(() => profiles.map(connectionProfileStorageKey), [profiles]);
  const [selectedIndex, setSelectedIndex, selectionMissing, isSelectionMissing] = useProfileSelection(profileKeys);
  const liveSelectionRef = useRef({ profiles, selectedIndex });
  useEffect(() => {
    liveSelectionRef.current = { profiles, selectedIndex };
  }, [profiles, selectedIndex, manualStore.blocked, manualStore.state.status, t]);

  // A subscription-owned server appears only after the Rust snapshot hydrates.
  // Keep Auto selected until that stable opaque key is available; never guess
  // profiles[0], which could silently change the exit country.
  useEffect(() => {
    if (selectionRestoreAttempted.current) return;
    const finish = () => {
      selectionRestoreAttempted.current = true;
      setSelectionRestoreSettled(true);
    };
    if (!lastServerPick || lastServerPick.kind === "auto") {
      setSelectedIndex(-1);
      finish();
      return;
    }
    const restored = restoreDesktopSelection(profiles, lastServerPick);
    if (restored.kind === "ambiguous") { requireSelectionChoice(true); finish(); return; }
    if (restored.kind === "selected") {
      setSelectedIndex(restored.index);
      finish();
      return;
    }
    if (subs.loaded) {
      requireSelectionChoice(true);
      setSelectedIndex(-1);
      finish();
    }
  }, [lastServerPick, profiles, subs.loaded]);

  // Save the server that actually reached Running, not merely the last row the
  // user clicked. Reconnects therefore update this value only after success.
  useEffect(() => {
    if (!selectionRestoreSettled || status.status !== "running" || selectionNeedsChoiceRef.current || isSelectionMissing()) return;
    const { profiles: currentProfiles, selectedIndex: currentIndex } = liveSelectionRef.current;
    if (currentIndex === -1) {
      saveLastServer({ kind: "auto" });
      return;
    }
    const profile = currentProfiles[currentIndex];
    const key = profile ? connectionProfileStorageKey(profile) : null;
    if (key) saveLastServer({ kind: "profile", key });
  }, [selectionRestoreSettled, status.status]);

  const readyProfileMetadata = useReadyProfileMetadata(profiles);

  // Online GeoIP fallback for servers the cheap heuristic in
  // `flagForProfile` couldn't resolve (no emoji, no Russian/English
  // name, no TLD). Hits ip-api.com once per uncached IP, then keeps
  // the result in localStorage forever. Lives after `profiles` is
  // declared because it takes the profile list as input.
  const geoip = useGeoIp(manualProfiles);

  const refresh = useCallback(async () => {
    const epoch=++refreshEpoch.current;
    if (!inTauri) {
      // Browser preview — show mock state.
      setBinary({
        path: "C:\\Users\\Алексей\\.minimax-agent\\projects\\singbox-client\\src-tauri\\binaries\\sing-box-x86_64-pc-windows-msvc.exe",
        exists: true,
        size_bytes: 51_732_480,
      });
      setVersion({
        version: "1.14.0-lx.24",
        environment: "go1.26.5 windows/amd64",
        revision: "42e693ce1cbb2f76d611f17fae137c40deaf85fc",
        raw: "sing-box version 1.14.0-lx.24\nEnvironment: go1.26.5 windows/amd64",
      });
      setXrayVersion("26.7.28");
      setStatus({
        status: "stopped",
        pid: null,
        uptime_secs: null,
        last_exit_code: null,
        last_error: null,
      });
      setLogs([
        {
          ts: new Date(Date.now() - 60_000).toISOString(),
          stream: "system",
          line: "preview mode — open this in the Tauri shell to control sing-box",
        },
        {
          ts: new Date(Date.now() - 30_000).toISOString(),
          stream: "system",
          line: "backend ready: process manager wired, default config generator in place",
        },
      ]);
      setManualProfiles(demoProfiles());
      setError(null);
      return;
    }
    try {
      // Only poll things that actually change: status + logs.
      // `getBinaryInfo` / `getSingboxVersion` are static (the binary
      // never changes under our feet) so we fetch them exactly once
      // in the mount effect below. Re-fetching them every tick used
      // to spawn `sing-box version` every 1.8 s and flash a CMD
      // window — even after we added CREATE_NO_WINDOW it was still
      // a wasted process; pulling them out of the hot loop removes
      // the flash entirely.
      const [st, log,health] = await Promise.all([
        api.getStatus(),
        api.getLogs(500),
        api.getConnectionDiagnostics().catch(()=>null),
      ]);
      if(epoch!==refreshEpoch.current)return;
      setDiagnostics(health);
      setStatus(st);
      setLogs(log);
      // While sing-box is up, also pull the currently-active
      // outbound from the clash API. This is what we show as
      // "Active: 🇳🇱 Нидерланды" in the hero — the source of
      // truth for which server the *running* selector is
      // actually using, not just the one the user picked (which
      // may differ if they switched to "Auto" and `urltest`
      // already migrated to a faster server).
      //
      // We serialise behind `getStatus` so the first poll after
      // a restart doesn't try to hit the clash API while the
      // old process is still dying. `listProxies` is allowed to
      // fail silently (the API may be unreachable for a tick
      // during a state transition), in which case we keep the
      // previous `activeOutbound` rather than blanking it out.
      if (st.status === "running") {
        try {
          const p = await api.listProxies();
          const now = p.proxies?.["proxy"]?.now ?? null;
          if(epoch===refreshEpoch.current)setActiveOutbound(now);
        } catch {
          // best effort
        }
      } else {
        // Stopped / starting / stopping: clear so the hero
        // doesn't keep showing a stale tag. React skips the
        // re-render if the value is already null.
        setActiveOutbound(null);
      }
      // Polling must not dismiss a rejected candidate's error card.
    } catch (e) {
      if(epoch===refreshEpoch.current)setError(humanError(e));
    }
  }, []);

  const retryHealth=useCallback(async(expected:SessionIdentity)=>{
    if(healthActionPending.current)return;
    const current=diagnosticsRef.current?.session;
    if(!current||!sameSessionIdentity(current,expected)){await refresh();return;}
    healthActionPending.current=true;setHealthActionBusy(true);setHealthActionMessage(null);
    try{
      await api.retryActiveProbe(expected);
      await refresh();
    }catch{
      setHealthActionMessage(t("health.retryStale"));await refresh();
    }finally{healthActionPending.current=false;setHealthActionBusy(false);}
  },[refresh,t]);

  // One-time static fetch: binary path/version. The version literally
  // cannot change while the app is running, so it doesn't belong in
  // the 1.8 s status poll.
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    (async () => {
      try {
        const [bin, ver, xray, appVer] = await Promise.all([
          api.getBinaryInfo(),
          api.getSingboxVersion().catch(() => null),
          api.getXrayVersion().catch(() => null),
          getVersion().catch(() => null),
        ]);
        if (cancelled) return;
        setBinary(bin);
        if (ver) setVersion(ver);
        if (xray) setXrayVersion(xray);
        if (appVer) setAppVersion(appVer);
      } catch (e) {
        if (!cancelled) setError(humanError(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Re-fetch the sing-box version. Called by the Home tab's
   * `UpdateCard` after a successful sing-box auto-update so the
   * status pill, logs, and version display all reflect the new
   * binary that lives at `<app_data_dir>/singbox-runtime/`.
   *
   * The binary path resolution itself is handled by
   * `ProcessManager::locate_binary` (it now prefers the runtime
   * copy over the bundled one), so we just ask for the version
   * again and trust the result.
   */
  const refetchSingboxVersion = useCallback(async () => {
    if (!inTauri) return;
    try {
      const ver = await api.getSingboxVersion().catch(() => null);
      if (ver) setVersion(ver);
    } catch (e) {
      // Non-fatal — the rest of the UI keeps working with the
      // stale version until the next manual refresh.
      console.error("refetchSingboxVersion failed:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Polling loop. Faster when starting/stopping, slower when steady.
  useEffect(() => {
    const interval =
      status.status === "starting" || status.status === "stopping" ? 700 : 1800;
    pollTimerRef.current = window.setInterval(() => {
      refresh();
    }, interval);
    return () => {
      if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
    };
  }, [status.status, refresh]);

  const startCancelledRef = useRef(false);
  const onStart = useCallback(async (overrideSettings?: GeneratorSettings, requestedIndex = selectedIndex, target?:ProfileSource, expectedSession?:SessionIdentity): Promise<boolean> => {
    const assertCurrent=profilePreparation();
    const attemptContext=connectionContext.current;
    startCancelledRef.current = false;
    ++refreshEpoch.current;setHealthActionMessage(null);
    if (manualStore.blocked || (!target && (selectionNeedsChoiceRef.current || isSelectionMissing()))) {
      setError(t(selectionNeedsChoiceRef.current || isSelectionMissing() ? "profileStorage.choose" : `profileStorage.${manualStore.state.status}`));
      return false;
    }
    if (!inTauri) {
      setError("Preview mode — start the Tauri shell to actually run sing-box.");
      return false;
    }
    if (!canStartManagedSelection(profiles, requestedIndex)) {
      setError("Selected subscription configuration is not executable yet.");
      return false;
    }
    const selection = managedSelectionForProfile(manualProfiles, profiles, requestedIndex);
    if (!selection) {
      setError("Selected subscription configuration is not executable yet.");
      return false;
    }
    const effectiveSettings =
      overrideSettings &&
      typeof overrideSettings === "object" &&
      "tunnel_mode" in overrideSettings
        ? overrideSettings
        : settings;
    setBusy(true);
    setError(null);
    setRoutingWarning(null);setAttemptEvidence(null);
    try {
      // 1. Always generate a fresh config from the imported profiles
      //    + current settings. The config we start with MUST include
      //    the VPN servers, otherwise the proxy accepts connections
      //    but routes them all to `direct`.
      const expectedCatalogEpoch=await api.profileCatalogEpoch();
      assertCurrent();
      const managed = await api.startManaged({
        expectedCatalogEpoch,
        expectedIdle:!!target&&!expectedSession,
        ...selection,
        expectedSourceRevision:(target??profileSources[requestedIndex])?.source_revision,
        expectedSession,
        manualProfileId:profiles[requestedIndex]?.kind==="manual"?profiles[requestedIndex].id:undefined,
        settings: effectiveSettings,
      });
      if (managed.routing.unavailable.length > 0) {
        setRoutingWarning(t("home.xrayRoutingWarning", {
          rules: managed.routing.unavailable.map((rule) => rule.label).join(", "),
        }));
      }
      const path = managed.config_path;
      setConfigPath(path);
      const next = managed.status;
      ++refreshEpoch.current;
      setStatus(next);

      // 3. Update system proxy state based on mode
      if (shouldFrontendApplySystemProxy(next.engine, effectiveSettings.tunnel_mode)) {
        const port = effectiveSettings.mixed_port ?? 2080;
        try {
          await api.applySystemProxy("127.0.0.1", port);
        } catch (e) {
          setError(
            `sing-box is running, but the system proxy couldn't be ` +
              `enabled automatically (${humanError(e)}). Set it ` +
              "manually in Settings → Network → Proxy.",
          );
        }
      } else if (next.engine === "singbox" && effectiveSettings.tunnel_mode === "tun") {
        try {
          await api.clearSystemProxy();
        } catch {
          // best-effort
        }
      }

      await refresh();
      setActiveTab("home");
      setReconnectRequired(false);
      setReconnectFailed(false);
      return true;
    } catch (e) {
      startCancelledRef.current = isProfileCheckCancelled(e);
      if (!startCancelledRef.current) {const source=target??profileSources[requestedIndex]??null;const message=["profile_source_changed","profile_source_busy"].includes(humanError(e))?t("profileEvidence.changed"):humanError(e);setErrorSource(source);setErrorContext(attemptContext);setActionError(message);if(source)setAttemptEvidence({source,kind:"preflight",outcome:"failed",checked_at:Date.now()});setError(message);}
      return false;
    } finally {
      setBusy(false);
    }
  }, [manualProfiles, profiles, selectedIndex, settings, refresh, t, manualStore.blocked, manualStore.state.status, selectionNeedsChoice, manualRevisions]);

  // Latest onStart, for handlers that need to call it after they've
  // already scheduled a state update (so the new settings object
  // is visible to onStart when it runs).
  const onStartRef = useRef(onStart);
  useEffect(() => {
    onStartRef.current = onStart;
  }, [onStart]);

  const reconnectCurrentProfile = useCallback(async (overrideSettings?: GeneratorSettings, requestedIndex = selectedIndex): Promise<boolean> => {
    if (manualStore.blocked || selectionNeedsChoiceRef.current || isSelectionMissing()) {
      setError(t(selectionNeedsChoiceRef.current || isSelectionMissing() ? "profileStorage.choose" : `profileStorage.${manualStore.state.status}`)); return false;
    }
    if (!inTauri) return false;
    setReconnectInProgress(true);
    setBusy(true);
    setError(null);
    try {
      const started = await reconnectManagedProfile(profiles, requestedIndex, {
        stop: async () => {
          try {
            await api.clearSystemProxy();
          } catch {
            // best-effort; the process stop/start remains authoritative
          }
          const stopped=await api.stop();
          ++refreshEpoch.current;
          setStatus(stopped);
        },
        start: (index) => onStartRef.current(overrideSettings, index),
      });
      if (started) {
        setReconnectRequired(false);
        setReconnectFailed(false);
      } else {
        setReconnectFailed(!startCancelledRef.current);
      }
      return started;
    } catch (e) {
      const wasCancelled = isProfileCheckCancelled(e);
      setReconnectFailed(!wasCancelled);
      if (!wasCancelled) setError(humanError(e));
      return false;
    } finally {
      setBusy(false);
      setReconnectInProgress(false);
    }
  }, [profiles, selectedIndex, manualStore.blocked, manualStore.state.status, t, isSelectionMissing]);

  const onStop = useCallback(async () => {
    ++refreshEpoch.current;setHealthActionMessage(null);
    if (!inTauri) return;
    setBusy(true);
    setError(null);
    setRoutingWarning(null);
    try {
      // 1. Clear the system proxy FIRST. sing-box is about to die and
      //    Windows DNS / WebView would otherwise sit without a working
      //    resolver for the few seconds it takes the child to exit.
      try {
        await api.clearSystemProxy();
      } catch {
        // best-effort
      }
      // 2. Now ask sing-box to exit. (If we did it the other way
      //    around, traffic would already be failing for ~2s before
      //    Windows noticed it should bypass the proxy again.)
      const next = await api.stop();
      setStatus(next);
      await refresh();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const onStopRef = useRef(onStop);
  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  const liveStatusRef = useRef(status);
  useEffect(() => {
    liveStatusRef.current = status;
  }, [status]);

  // Synchronize status with desktop system tray
  useEffect(() => {
    if (!inTauri) return;
    const isConnected = status.status === "running";
    const accepted=diagnostics?.session?.run_id===status.run_id?diagnostics?.session:null;
    const activeName=isConnected?(accepted?accepted.display_name:status.profile_name??null):null;
    void api.updateTrayStatus(isConnected, activeName).catch(() => {});
  }, [inTauri, status.status, status.run_id, status.profile_name, diagnostics]);

  // Desktop notifications on connection status changes
  const prevStatusRef = useRef<Status>(status.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev !== status.status) {
      if (prev !== "running" && status.status === "running") {
        const accepted=diagnostics?.session?.run_id===status.run_id?diagnostics?.session:null;
        const activeName=accepted?accepted.display_name:status.profile_name??null;
        void notify(
          t("notify.titleConnected"),
          `${t("notify.bodyConnected")} ${activeName || ""}`.trim(),
        );
      } else if (prev === "running" && status.status === "stopped") {
        void notify(t("notify.titleDisconnected"), t("notify.bodyDisconnected"));
      } else if (prev === "running" && status.status === "crashed") {
        void notify(t("notify.titleCrashed"), t("notify.bodyCrashed"));
      }
      prevStatusRef.current = status.status;
    }
  }, [status.status, status.run_id, status.profile_name, diagnostics, t]);

  // Listen for tray connect/disconnect toggle event
  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    listen("tray:toggle-connect", () => {
      if (liveStatusRef.current.status === "running") {
        void onStopRef.current();
      } else {
        void onStartRef.current();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [inTauri]);

  const onPickConfig = useCallback(async () => {
    if (!inTauri) {
      setError("File picker is only available inside the Tauri shell.");
      return;
    }
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "sing-box config", extensions: ["json"] },
          { name: "All", extensions: ["*"] },
        ],
      });
      if (typeof picked === "string") {
        setConfigPath(picked);
      }
    } catch (e) {
      setError(humanError(e));
    }
  }, []);

  const onUseDefault = useCallback(() => {
    void (async () => {
      if (!inTauri) {
        setError("Default config writer is only available inside the Tauri shell.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const path = await api.writeDefaultConfig();
        setConfigPath(path);
        await api.checkConfig(path);
      } catch (e) {
        setError(humanError(e));
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  // Link / subscription parser (auto-detect).
  const profileImport = useProfileImport(manualStore, () => setReconnectRequired(previous => nextReconnectRequired(previous, status.status === "running")));
  const onImportText = useCallback(async (rawText: string): Promise<boolean> => {
      const text = rawText.trim();
      if (!text) return false;
      setParsing(true);
      setImportError(null);
      setParseErrors([]);
      try {
        if (!inTauri) {
          // Browser preview: tiny client-side mock — treat every
          // non-empty line as a vless:// link.
          const lines = text
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
          if (lines.length === 0) {
            setImportError(t("profileImport.unsupported"));
            return false;
          }
          const linkLines = lines.filter((l) => !/^https?:\/\//i.test(l));
          const urlLines = lines.filter((l) => /^https?:\/\//i.test(l));
          if (linkLines.length > 0) {
            const mocks: Outbound[] = linkLines.slice(0, 3).map((l, i) => ({
              protocol: "vless",
              tag: `preview-node-${i + 1}`,
              server: `mock-${i + 1}.example.com`,
              port: 443,
              uuid: "00000000-0000-0000-0000-000000000000",
              flow: "xtls-rprx-vision",
              transport: { kind: "tcp" },
              tls: {
                enabled: true,
                server_name: `mock-${i + 1}.example.com`,
                alpn: ["h2", "http/1.1"],
                reality: { public_key: "PREVIEW", short_id: "abcd" },
                allow_insecure: false,
              },
            }));
            if (!await profileImport.request(mocks)) return false;
          }
          for (const u of urlLines) {
            await subs.add({ url: u });
          }
          setPendingLinks("");
          return true;
        }
        const result = await api.parseInput(text);
        if (result.outbounds.length && !await profileImport.request(result.outbounds)) return false;
        let imported = result.outbounds.length;
        const failures = [...result.failures];
        for (const url of result.subscriptions) {
          try {
            await subs.add({ url });
            imported++;
          } catch (cause) {
            failures.push({ line: url, error: { kind: "subscription", message: humanError(cause) } });
          }
        }
        setParseErrors(failures);
        if (failures.length) {
          if (imported > 0) {
            setPendingLinks(failures.map(f => f.line).join("\n"));
            setImportError(t("profileImport.partial"));
          }
          return false;
        }
        if (imported === 0) {
          setImportError(t("profileImport.unsupported"));
          return false;
        }
        setPendingLinks("");
        return true;
      } catch (cause) {
        setImportError(humanError(cause));
        return false;
      } finally {
        setParsing(false);
      }
  }, [inTauri, subs, profileImport.request, t]);

  const onSelectProfile = useCallback(
    async (index: number) => {
      // index === -1 means "Auto (best latency)" — drop the pin,
      // let the `auto` urltest decide.
      const isAuto = index === -1;
      const selected = profiles[index];
      const pickedTag = isAuto
        ? null
        : selected?.kind === "manual" && isSupported(selected.outbound)
          ? selected.outbound.tag
          : selected?.kind === "subscription"
            ? selected.label
            : null;
      const nextSettings = { ...settings, default_outbound: pickedTag };
      requireSelectionChoice(false);
      setSelectedIndex(index);
      setSettings(nextSettings);
      if (shouldReconnectAfterProfileSelection(status.status)) {
        await reconnectCurrentProfile(nextSettings, index);
      }
    },
    [profiles, settings, status.status, reconnectCurrentProfile],
  );

  const onRemoveProfile = useCallback((idx: number) => {
    const profile = profiles[idx];
    if (!profile || profile.kind !== "manual") return;
    const manualIndex = profiles
      .slice(0, idx)
      .filter((entry) => entry.kind === "manual").length;
    setManualProfiles((prev) => prev.filter((_, index) => index !== manualIndex));
  }, [profiles]);

  const onClearProfiles = useCallback(() => {
    setManualProfiles([]);
    setParseErrors([]);
  }, []);

  const isRunning = status.status === "running";

  // Tabs are assembled here so they can close over the live state
  // (profiles, status, error, …) without prop-drilling. Order matters.
  const acceptedSource=diagnostics?.session?.source_revision?{profile_ref:diagnostics.session.profile_ref,source_revision:diagnostics.session.source_revision}:null;
  const cardActions=useProfileErrorActions({
    contextKey,ownerContextKey:error?errorContext??undefined:undefined,
    target:error?(error===actionError?errorSource:null):acceptedSource,sources:profileSources,disabled:busy||healthActionBusy,
    refresh:subs.refreshOne,choose:()=>setActiveTab("servers"),
    reconnect:async(index,target)=>{
      const profile=profiles[index];
      const default_outbound=profile?.kind==="manual"&&isSupported(profile.outbound)?profile.outbound.tag:profile?.kind==="subscription"?profile.label:null;
      await onStart({...settings,default_outbound},index,target,diagnostics?.session??undefined);
    }
  });
  const tabs: TabDef[] = useMemo(
    () => [
      {
        id: "home",
        label: t("nav.home"),
        icon: Home,
        content: (
          <HomeTab
            status={status}
            statusLabel={status.status}
            busy={busy}
            error={error}
            errorActions={<ProfileErrorActions {...cardActions}/>}
            runtimeActions={!error?<ProfileErrorActions {...cardActions}/>:undefined}
            diagnostics={diagnostics}
            onRetryHealth={retryHealth}
            healthActionBusy={healthActionBusy}
            healthActionMessage={healthActionMessage}
            onDismissError={() => setError(null)}
            canStart={canStartManagedSelection(profiles, selectedIndex)}
            configName={configPath ? basename(configPath) : null}
            profiles={profiles}
            selectedIndex={selectedIndex}
            activeOutbound={activeOutbound}
            readyProfileMetadata={readyProfileMetadata}
            subscriptionNames={subscriptionNames}
            geoipByIp={geoip.byIp}
            subscriptionOutbounds={subs.lastResult}
            onSelect={onSelectProfile}
            onConnect={() => { void onStart(); }}
            onDisconnect={() => { void onStop(); }}
            routingOptions={settings.routing}
            onNavigateTab={(t) => setActiveTab(t as TabId)}
            onOpenImport={openImport}
            settings={settings}
            onSettingsChange={handleSettingsChange}
            onReconnect={reconnectCurrentProfile}
          />
        ),
      },
      {
        id: "servers",
        label: t("nav.servers"),
        icon: Link2,
        badge: profiles.length > 0 ? profiles.length : undefined,
        content: (
          <ServersTab
            profiles={profiles}
            onOpenImport={openImport}
            onRemove={onRemoveProfile}
            onClearAll={onClearProfiles}
            subs={subs.snapshot.subscriptions}
            geoipByIp={geoip.byIp}
            readyProfileMetadata={readyProfileMetadata}
            subFetching={subs.fetching}
            onAddSub={subs.add}
            onRemoveSub={subs.remove}
            onRefreshSub={subs.refreshOne}
            onRefreshAllSubs={subs.refreshAll}
            onSetSubInterval={subs.setIntervalFor}
            onSelectSubChild={subs.selectChild}
          />
        ),
      },
      {
        id: "config",
        label: t("nav.settings"),
        icon: Settings2,
        content: (
          <ConfigTab
            configPath={configPath}
            binary={binary}
            version={version}
            xrayVersion={xrayVersion}
            status={status}
            profiles={manualProfiles}
            settings={settings}
            onSettingsChange={handleSettingsChange}
            onResetSettings={() => handleSettingsChange(DEFAULT_SETTINGS)}
            onPickConfig={onPickConfig}
            onUseDefault={onUseDefault}
            onConfigPath={(p) => {
              if (p) setConfigPath(p);
            }}
            currentSingboxVersion={version?.version ?? null}
            onSingboxUpdated={refetchSingboxVersion}
          />
        ),
      },
      {
        id: "routing",
        label: t("nav.routing"),
        icon: Route,
        badge:
          settings.routing.rules.length + settings.routing.rule_sets.length > 0
            ? settings.routing.rules.length + settings.routing.rule_sets.length
            : undefined,
        content: (
          <RoutingTab
            engine={(() => { const selected = profiles[selectedIndex]; return selected?.kind === "ready_config" ? selected.engine : "singbox"; })()}
            profiles={manualProfiles}
            settings={settings}
            onSettingsChange={handleSettingsChange}
          />
        ),
      },
      {
        id: "logs",
        label: t("nav.logs"),
        icon: Terminal,
        content: <LogsTab logs={logs} onClear={() => setLogs([])} />,
      },
    ],
    [
      status,
      diagnostics,cardActions,
      retryHealth,
      healthActionBusy,
      healthActionMessage,
      busy,
      error,
      configPath,
      manualProfiles,
      profiles,
      selectedIndex,
      readyProfileMetadata,
      onStart,
      onStop,
      onSelectProfile,
      openImport,
      t,
      onRemoveProfile,
      onClearProfiles,
      subs.subs,
      subs.fetching,
      subs.add,
      subs.remove,
      subs.refreshOne,
      subs.refreshAll,
      subs.setIntervalFor,
      subs.selectChild,
      binary,
      version,
      xrayVersion,
      onPickConfig,
      onUseDefault,
      logs,
    ],
  );

  return (
    <div className="atlas-shell atlas-desktop relative h-screen overflow-hidden text-foreground">

      <header className="atlas-rail">
        <div className="atlas-brand"><img src={cloakwireLogo} alt=""/><strong>CloakWire</strong></div>
        <TabBar
          tabs={tabs}
          active={activeTab}
          onChange={(id) => setActiveTab(id as TabId)}
        />

        <div className="atlas-rail-session">
          <StatusPill
            status={status.status}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              if (status.status === "running") {
                void onStop();
              } else if (
                status.status === "stopped" ||
                status.status === "crashed"
              ) {
                void onStart();
              }
            }}
          />
          <div className="atlas-build-info">
            <span>CloakWire <b>v{appVersion}</b></span>
            <small>{version || xrayVersion
              ? [version && `sing-box ${version.version}`, xrayVersion && `Xray ${xrayVersion}`].filter(Boolean).join(" · ")
              : binary?.exists ? basename(binary.path) : t("config.scanningBinaries")}</small>
          </div>
        </div>
      </header>
      <div className="atlas-workspace">
      {shouldShowReconnectNotice({
        reconnectInProgress,
        reconnectRequired,
        reconnectFailed,
        status: status.status,
      }) && (
        <div
          role="status"
          className="relative z-10 flex items-center justify-between gap-3 border-b border-primary/20 bg-primary/5 px-6 py-2 text-xs"
        >
          <p className="text-foreground/80">
            {t("settings.reconnectNotice")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void reconnectCurrentProfile()}
            disabled={busy}
            aria-busy={busy}
          >
            {t("settings.reconnectNow")}
          </Button>
        </div>
      )}

      {routingWarning && (
        <div role="status" className="relative z-10 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
          {routingWarning}
        </div>
      )}

      {/* Body — fills the rest of the viewport with the active tab. */}
      <ProfileHealthContext.Provider value={{sources:profileSources,evidence:activeEvidence(status,diagnostics),attempt:attemptEvidence}}>
      <main ref={workspaceMain} className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {importOpen && !profileImport.plan && <ServerImportDialog value={pendingLinks} busy={parsing}
          failures={parseErrors} error={importError ?? (manualStore.blocked ? t("profileStorage."+manualStore.state.status) : null)} onChange={value => {
            setPendingLinks(value); setParseErrors([]); setImportError(null);
          }}
          onClose={() => setImportOpen(false)}
          onSubmit={async () => { if (await onImportText(pendingLinks)) setImportOpen(false); }} />}
        <ProfileImportDialog plan={profileImport.plan} records={manualRecords} error={profileImport.error} onApply={profileImport.apply} onCancel={profileImport.cancel} />
      <ManualProfileStorageNotice state={manualStore.state} retry={manualStore.retry} reconcile={manualStore.reconcile} />
        {(selectionNeedsChoice || selectionMissing) && <p role="alert" className="m-3 text-sm">{t("profileStorage.choose")}</p>}
        {tabs.find((t) => t.id === activeTab)?.content}
      </main>
      </ProfileHealthContext.Provider>
      </div>

      <UpdateModal
        open={updateModalOpen}
        version={appUpdateInfo?.version ?? ""}
        currentVersion={appUpdateInfo?.current_version ?? ""}
        notes={appUpdateInfo?.notes}
        onUpdate={handleUpdateApp}
        onDismiss={handleDismissUpdate}
        busy={updateBusy}
        error={updateError}
      />
    </div>
  );
}

function demoProfiles(): Outbound[] {
  return [
    {
      protocol: "vless",
      tag: "🇩🇪 DE-Reality-1",
      server: "de-1.example.com",
      port: 443,
      uuid: "b2a3d6c8-1111-2222-3333-444455556666",
      flow: "xtls-rprx-vision",
      transport: { kind: "grpc", service_name: "" },
      tls: {
        enabled: true,
        server_name: "cdn.example.com",
        alpn: ["h2", "http/1.1"],
        fingerprint: "chrome",
        reality: { public_key: "REAL_PUBLIC_KEY_HERE", short_id: "abcd" },
        allow_insecure: false,
      },
    },
    {
      protocol: "hysteria2",
      tag: "🇳🇱 NL-Hy2-Edge",
      server: "nl-edge.example.org",
      port: 443,
      password: "demo-passphrase",
      tls: {
        enabled: true,
        server_name: "nl-edge.example.org",
        alpn: ["h3"],
        allow_insecure: false,
      },
      obfs: { type: "salamander", password: "obfs-secret" },
    },
    {
      protocol: "shadowsocks",
      tag: "🇸🇬 SG-AES",
      server: "sg.example.net",
      port: 8388,
      method: "chacha20-ietf-poly1305",
      password: "shadowsocks-secret",
    },
    {
      protocol: "trojan",
      tag: "🇺🇸 US-Trojan",
      server: "us.example.com",
      port: 443,
      password: "trojan-pass",
      transport: { kind: "ws", path: "/trojan", headers: [["Host", "us.example.com"]] },
      tls: { enabled: true, server_name: "us.example.com", alpn: [], allow_insecure: false },
    },
  ];
}
