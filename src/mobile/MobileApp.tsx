import {profilePreparation} from "@/lib/profilePreparations";
import {vpnBeginPreparation} from "@/lib/vpn";
import {ProfileHealthContext} from "@/components/ProfileHealthBadge";
import {ProfileErrorActions} from "@/components/ProfileErrorActions";
import {useProfileErrorActions} from "@/hooks/useProfileErrorActions";
import {useSourceRevisions} from "@/hooks/useSourceRevisions";
import {findSourceIndex,type ProfileSource} from "@/lib/profileEvidence";
import { useProfileImport } from "@/hooks/useProfileImport";
import { ProfileImportDialog } from "@/components/ProfileImportDialog";
import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import {
  Home,
  Link2,
  RefreshCw,
  Route,
  Settings2,
} from "lucide-react";
import cloakwireLogo from "@/assets/cloakwire-logo.png";
import { api } from "@/lib/api";
import { humanError, isProfileCheckCancelled, profileCheckDetails } from "@/lib/profileCheck";
import { reconnectSelectedProfile } from "@/lib/reconnectState";
import { useGeoIp } from "@/hooks/useGeoIp";
import { useSubscriptions } from "@/hooks/useSubscriptions";
import { useManualProfiles } from "@/hooks/useManualProfiles";
import { useProfileSelection } from "@/hooks/useProfileSelection";
import { ManualProfileStorageNotice } from "@/components/ManualProfileStorageNotice";
import { isSupported, profileLabel } from "@/lib/outbound";
import { isValidProfileSelection } from "@/lib/profileSelection";
import { cn } from "@/lib/utils";
import type { GeneratorSettings, Outbound } from "@/lib/types";
import {
  loadAutoConnect,
  loadSettings,
  saveAutoConnect,
  saveSettings,
} from "./lib/settings";
import { loadLastServer, saveLastServer } from "./lib/lastServer";
import { useVpnConnection } from "./useVpnConnection";
import { useI18n } from "@/lib/i18n";
import { HomeScreen } from "./screens/HomeScreen";
import { ServersScreen } from "./screens/ServersScreen";
import { RoutingScreen } from "./screens/RoutingScreen";
import { LogsScreen } from "./screens/LogsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { UpdateModal } from "@/components/UpdateModal";
import { adjacentTabIndex, swipeDirection } from "./lib/mobileUi";
import {
  nextReconnectRequired,
  shouldShowReconnectNotice,
} from "./lib/reconnectState";
import { buildGroupedServerProfiles } from "./lib/serverGrouping";

type TouchStart = {
  x: number;
  y: number;
  target: EventTarget | null;
};

const TABS = [
  { id: "home", label: "Home", icon: Home },
  { id: "servers", label: "Servers", icon: Link2 },
  { id: "routing", label: "Routing", icon: Route },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;
type TabId = (typeof TABS)[number]["id"];

const TAB_KEY = "singbox.mobile.tab";

/** Stable identity of a built profile row — the same string the
 * grouped builder produces (with the `@host:port` suffix it adds on
 * duplicate tags). Used to persist the selection across restarts. */
const tagOf = (p: Outbound) => ("tag" in p ? p.tag : p.raw);

function readStoredTab(): TabId {
  try {
    const v = window.localStorage.getItem(TAB_KEY);
    if (v && (TABS as readonly { id: string }[]).some((t) => t.id === v)) {
      return v as TabId;
    }
  } catch {
    /* storage disabled — fall through */
  }
  return "home";
}

export default function MobileApp() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<TabId>(readStoredTab);
  const [logsOpen, setLogsOpen] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState<"previous" | "next">("next");

  const tabs = useMemo(
    () => [
      { id: "home" as const, label: t("nav.home"), icon: Home },
      { id: "servers" as const, label: t("nav.servers"), icon: Link2 },
      { id: "routing" as const, label: t("nav.routing"), icon: Route },
      { id: "settings" as const, label: t("nav.settings"), icon: Settings2 },
    ],
    [t]
  );
  const [settings, setSettings] = useState<GeneratorSettings>(loadSettings);
  const [autoConnect, setAutoConnect] = useState<boolean>(loadAutoConnect);
  const manualStore = useManualProfiles();
  const { outbounds: manualProfiles, setOutbounds: setManualProfiles, records: manualRecords } = manualStore;
  const [selectionNeedsChoice, setSelectionNeedsChoice] = useState(false);
  // Bundle subscription selection. null when the user has no
  // bundle child picked (or the only subscriptions are link-list).
  // Mutually exclusive with `selectedIndex` — picking a bundle
  // child clears the share-link pick and vice versa.
  // 2026-08-20.
  const [activeBundle, setActiveBundle] = useState<{
    subscriptionId: string;
    childKey: string;
    engine: "singbox" | "xray";
    childName: string;
  } | null>(null);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [reconnectFailed, setReconnectFailed] = useState(false);
  const [reconnectInProgress, setReconnectInProgress] = useState(false);
  // Last `reconnect()` failure message — surfaced in the banner so
  // the user can see *why* a reconnect failed instead of just
  // "Reconnect failed. Try again." 2026-08-21.
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const reconnectPhase = useRef<"idle" | "disconnecting" | "connecting">("idle");
  const contentRef = useRef<HTMLElement | null>(null);
  const touchStart = useRef<TouchStart | null>(null);

  const subs = useSubscriptions();

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveAutoConnect(autoConnect), [autoConnect]);
  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_KEY, activeTab);
    } catch {
      /* ignore */
    }
  }, [activeTab]);

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
        // ignore
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
      const msg = e instanceof Error ? e.message : String(e);
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

  // Link-list outbounds persisted in Rust — fetched once per
  // subscription on mount so the server list is complete right after
  // an app restart (a fetch in THIS session overrides them).
  const [hydratedOutbounds, setHydratedOutbounds] = useState<
    Record<string, { outbounds: Outbound[] }>
  >({});
  const hydratedIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const missing = subs.subs.filter(
      (s) => s.kind === "link_list" && !subs.lastResult[s.id],
    );
    if (missing.length === 0) return;
    if (hydratedIds.current === null) hydratedIds.current = new Set();
    let cancelled = false;
    for (const sub of missing) {
      if (hydratedIds.current.has(sub.id)) continue;
      hydratedIds.current.add(sub.id);
      void api.getSubscriptionOutbounds(sub.id).then((outbounds) => {
        if (cancelled || outbounds.length === 0) return;
        setHydratedOutbounds((prev) => ({
          ...prev,
          [sub.id]: { outbounds },
        }));
      }).catch(() => {
        /* unreadable subscription — the Servers tab surfaces errors */
      });
    }
    return () => {
      cancelled = true;
    };
  }, [subs.subs, subs.lastResult]);

  const effectiveLastResult = useMemo(
    () => ({ ...hydratedOutbounds, ...subs.lastResult }),
    [hydratedOutbounds, subs.lastResult],
  );

  const { profiles, groups: serverGroups } = useMemo(
    () => buildGroupedServerProfiles(manualProfiles, subs.subs, effectiveLastResult, manualRecords.map(r => r.id)),
    [manualProfiles, subs.subs, effectiveLastResult, manualRecords],
  );

  const sourceRevisions=useSourceRevisions(profiles);
  const profileSources:(ProfileSource|null)[]=profiles.map(()=>null);
  for(const group of serverGroups)for(const entry of group.entries){
    const revision=entry.manualId?sourceRevisions[entry.profileIndex]:subs.snapshot.link_outbounds.find(g=>g.subscription_id===group.subscriptionId)?.links.find(l=>l.key==="index-"+entry.sourceIndex)?.source_revision;
    if(revision)profileSources[entry.profileIndex]={profile_ref:entry.manualId?{kind:"manual",id:entry.manualId}:{kind:"subscription",subscription_id:group.subscriptionId!,link_key:"index-"+entry.sourceIndex},source_revision:revision};
  }
  const readySources:ProfileSource[]=subs.subs.flatMap(sub=>sub.children.flatMap(child=>child.source_revision?[{profile_ref:{kind:"ready" as const,subscription_id:sub.id,child_key:child.key},source_revision:child.source_revision}]:[]));
  const allSources=[...profileSources,...readySources];
  const profileKeys = useMemo(() => {
    const keys: string[] = [];
    for (const group of serverGroups) for (const entry of group.entries) {
      keys[entry.profileIndex] = entry.manualId ? `manual:${entry.manualId}` : `subscription:${group.subscriptionId}:${entry.profileIndex - (group.entries[0]?.profileIndex ?? 0)}`;
    }
    return keys;
  }, [serverGroups]);
  const [selectedIndex, setSelectedIndex, selectionMissing, isSelectionMissing] = useProfileSelection(profileKeys, 0);
  const geoip = useGeoIp(profiles);

  // xray sends unmatched traffic to the FIRST outbound, so the list
  // handed to the VPN must lead with the picked server — the UI
  // order (manual first, then subscriptions) is not the connect
  // order. "Auto" (-1) keeps the built order as-is.
  const connectionProfiles = useMemo(() => {
    if (selectedIndex < 0 || selectedIndex >= profiles.length) return profiles;
    const picked = profiles[selectedIndex];
    if (!picked || !isSupported(picked)) return profiles;
    return [
      picked,
      ...profiles.filter((_, index) => index !== selectedIndex),
    ];
  }, [profiles, selectedIndex]);

  const connection = useVpnConnection(connectionProfiles, settings);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const vpn = { ...connection, busy: connection.busy || selectionBusy };

  const markConnectionDirty = () => {
    setReconnectRequired((previous) => nextReconnectRequired(previous, vpn.state));
  };

  // ---- Last-connected-server persistence ------------------------------
  // Saved when a connect reaches "running", restored on the next
  // cold start so the UI (and auto-connect) points at the server the
  // user actually used instead of `profiles[0]`.

  const [restoreSettled, setRestoreSettled] = useState(false);
  const [restorePick] = useState(() => loadLastServer());
  const restoreAttempted = useRef(false);

  // Snapshots for the "running" transition — the effect below keys
  // on vpn.state only, so it must read the selection as of that
  // moment rather than through closure deps (which would re-fire on
  // every selection change while connected).
  const activeBundleRef = useRef(activeBundle);
  const selectedIndexRef = useRef(selectedIndex);
  const profilesRef = useRef(profiles);
  useEffect(() => {
    activeBundleRef.current = activeBundle;
    selectedIndexRef.current = selectedIndex;
    profilesRef.current = profiles;
  }, [activeBundle, selectedIndex, profiles]);

  useEffect(() => {
    if (vpn.state !== "running" || !restoreSettled || selectionNeedsChoice || isSelectionMissing()) return;
    const bundle = activeBundleRef.current;
    if (bundle) {
      saveLastServer({
        kind: "bundle",
        subscriptionId: bundle.subscriptionId,
        childKey: bundle.childKey,
        engine: bundle.engine,
        childName: bundle.childName,
      });
      return;
    }
    const index = selectedIndexRef.current;
    if (index === -1) {
      saveLastServer({ kind: "auto" });
      return;
    }
    const picked = profilesRef.current[index];
    if (picked && isSupported(picked)) {
      const key = profileKeys[index];
      if (key?.startsWith("manual:")) saveLastServer({ kind: "manual", id: key.slice(7) });
      else saveLastServer({ kind: "profile", tag: tagOf(picked) });
    }
  }, [vpn.state, restoreSettled]);

  // Restore: the pick may reference a subscription outbound that
  // only appears once hydration finishes, so keep trying while the
  // list settles; a 5s timeout gives up so auto-connect is never
  // blocked forever. `restoreSettled` also gates the auto-connect
  // effect below — it must not fire with the default selection
  // while the real pick is still being located.

  useEffect(() => {
    if (restoreAttempted.current) return;
    const pick = restorePick;
    const finish = () => {
      if (restoreAttempted.current) return;
      restoreAttempted.current = true;
      setRestoreSettled(true);
    };
    if (!pick) {
      finish();
      return;
    }
    if (pick.kind === "auto") {
      setSelectedIndex(-1);
      setActiveBundle(null);
      finish();
      return;
    }
    if (pick.kind === "bundle") {
      if (subs.subs.some((s) => s.id === pick.subscriptionId)) {
        setActiveBundle({
          subscriptionId: pick.subscriptionId,
          childKey: pick.childKey,
          engine: pick.engine,
          childName: pick.childName,
        });
        setSelectedIndex(-1);
        finish();
      }
      return;
    }
    const matches = pick.kind === "manual"
      ? profileKeys.map((key, index) => key === `manual:${pick.id}` ? index : -1).filter(index => index >= 0)
      : profiles.map((p, index) => {
          const key = profileKeys[index];
          const original = key?.startsWith("manual:") ? manualRecords.find(r => r.id === key.slice(7))?.outbound : undefined;
          return tagOf(p) === pick.tag || (original && tagOf(original) === pick.tag) ? index : -1;
        }).filter(index => index >= 0);
    if (matches.length > 1) { setSelectedIndex(-1); setSelectionNeedsChoice(true); finish(); return; }
    if (pick.kind === "manual" && !matches.length) { setSelectedIndex(-1); setSelectionNeedsChoice(true); finish(); return; }
    const index = matches[0] ?? -1;
    if (index >= 0) {
      setSelectedIndex(index);
      setActiveBundle(null);
      finish();
    }
  }, [profiles, subs.subs]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!restoreAttempted.current) {
        restoreAttempted.current = true;
        if (restorePick && restorePick.kind !== "auto") { setSelectedIndex(-1); setSelectionNeedsChoice(true); }
        setRestoreSettled(true);
      }
    }, 5000);
    return () => window.clearTimeout(t);
  }, []);
  // ----------------------------------------------------------------------

  // IDs remain stable even when duplicate labels are disambiguated for the core.
  const profileImport = useProfileImport(manualStore, markConnectionDirty);

  const removeManualProfile = async(id: string) => {
    if (await manualStore.saveRecords(manualRecords.filter(r => r.id !== id))) markConnectionDirty();
  };
  const setMobileSettings = (next: GeneratorSettings) => {
    setSettings(next);
    markConnectionDirty();
  };

  const reconnect = async () => {
    if (vpn.busy || reconnectInProgress || manualStore.blocked || selectionNeedsChoice || isSelectionMissing()) return;
    setReconnectInProgress(true);
    setReconnectFailed(false);
    setReconnectError(null);
    try {
      await reconnectSelectedProfile({
        readyProfile: !!activeBundle,
        stop: async () => {
          if (vpn.state === "running") {
            reconnectPhase.current = "disconnecting";
            await vpn.disconnect();
            await new Promise((resolve) => window.setTimeout(resolve, 50));
          }
        },
        start: async () => {
          reconnectPhase.current = "connecting";
          await connectWithSelection();
        },
      });
    } catch (e) {
      reconnectPhase.current = "idle";
      setReconnectInProgress(false);
      if (isProfileCheckCancelled(e)) {
        setReconnectFailed(false);
        setReconnectError(null);
        return;
      }
      setReconnectFailed(true);
      // `e` may be an Error, a TauriCommandError-like object with
      // `{ message }`, or anything else thrown by the IPC layer.
      // Normalise to a string so the banner can render it.
      setReconnectError(humanError(e));
    }
  };

  useEffect(() => {
    if (reconnectPhase.current !== "connecting") return;
    if (vpn.cancelled) {
      reconnectPhase.current = "idle";
      setReconnectInProgress(false);
      setReconnectFailed(false);
      setReconnectError(null);
    } else if (vpn.error || (vpn.state === "error" && vpn.message && !vpn.busy)) {
      reconnectPhase.current = "idle";
      setReconnectInProgress(false);
      setReconnectFailed(true);
      setReconnectError(vpn.error ?? "VPN failed to start.");
    } else if (vpn.state === "running" && !vpn.busy) {
      reconnectPhase.current = "idle";
      setReconnectInProgress(false);
      setReconnectRequired(false);
      setReconnectFailed(false);
      setReconnectError(null);
    }
  }, [vpn.error, vpn.message, vpn.state, vpn.busy, vpn.cancelled]);

  const changeTab = (nextTab: TabId, direction?: "previous" | "next") => {
    if (nextTab === activeTab) return;
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    const nextIndex = TABS.findIndex((tab) => tab.id === nextTab);
    if (currentIndex < 0 || nextIndex < 0) return;
    setTransitionDirection(direction ?? (nextIndex > currentIndex ? "next" : "previous"));
    setLogsOpen(false);
    setActiveTab(nextTab);
  };

  const onTouchStart = (event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    // If the touch begins inside a sheet / modal / dialog, do not
    // record a start position — the swipe-to-switch-tab gesture
    // would otherwise trigger when the user drags on the
    // AddSubscriptionSheet backdrop or the dialog body. 2026-08-21.
    const target = event.target as Element | null;
    if (target?.closest("[data-mobile-sheet], [role='dialog'], [role='alertdialog']")) {
      touchStart.current = null;
      return;
    }
    touchStart.current = { x: touch.clientX, y: touch.clientY, target: event.target };
  };

  const onTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = touchStart.current;
    touchStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const direction = swipeDirection({
      dx: touch.clientX - start.x,
      dy: touch.clientY - start.y,
      startTarget: start.target,
      // Controls are allowed everywhere: server rows are buttons, so
      // gating on them made swipes practically unusable on Home and
      // Servers. A tap still fires a click (no movement); a real
      // swipe does not. Editable fields keep aborting the gesture.
      allowControls: true,
      scrollContainer: contentRef.current,
    });
    if (!direction) return;
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    const nextIndex = adjacentTabIndex(currentIndex, direction, TABS.length);
    if (nextIndex !== currentIndex) changeTab(TABS[nextIndex].id, direction);
  };

  // Auto-connect on launch (opt-in from Settings). Fires once the
  // initial vpnStatus() has resolved so we don't fight a tunnel
  // that's already up. Honours the active bundle pick (if any) so
  // the auto-connect picks up the user's saved bundle child, not
  // the empty share-link list. 2026-08-20.
  const autoConnectFired = useRef(false);
  useEffect(() => {
    const canShareLinkAuto =
      !activeBundle && profiles.length > 0;
    if (
      autoConnect &&
      !manualStore.blocked && !selectionNeedsChoice && !selectionMissing &&
      restoreSettled &&
      vpn.ready &&
      !autoConnectFired.current &&
      vpn.state === "stopped" &&
      (canShareLinkAuto || activeBundle)
    ) {
      autoConnectFired.current = true;
      void connectWithSelection();
    }
  }, [
    autoConnect,
    manualStore.blocked,
    selectionNeedsChoice,
    selectionMissing,
    restoreSettled,
    vpn.ready,
    vpn.state,
    profiles.length,
    activeBundle,
    vpn.connect,
  ]);

  const onSelectProfile = (index: number) => {
    const isAuto = index === -1;
    let pickedTag: string | null = null;
    if (!isAuto) {
      const p = profiles[index];
      if (!p || !isSupported(p)) return;
      pickedTag = p.tag;
    }
    setSelectionNeedsChoice(false);
    setSelectedIndex(index);
    setActiveBundle(null);
    setMobileSettings({ ...settings, default_outbound: pickedTag });
  };

  // Pick a bundle child as the active target. Mirrors `onSelectProfile`
  // for the share-link path: pins the child server-side, clears the
  // share-link pick, marks the connection dirty. The next connect
  // will fetch the full config from Rust. 2026-08-20.
  const onSelectBundleChild = async (input: {
    subscriptionId: string;
    childKey: string;
    engine: "singbox" | "xray";
    childName: string;
  }) => {
    try {
      await subs.setActiveChild(input.subscriptionId, input.childKey);
    } catch (e) {
      // Surface the error via the global error path — the picker
      // can show a toast in a future iteration; for now the
      // settings banner is the only place we render errors.
      console.error("setActiveChild failed", e);
    }
    setSelectionNeedsChoice(false);
    setActiveBundle(input);
    setSelectedIndex(-1);
    // setMobileSettings already calls markConnectionDirty — the
    // next connect uses the new bundle pick, so the user needs
    // the reconnect banner.
    setMobileSettings({ ...settings, default_outbound: null });
  };

  const connectWithSelection = async (target?:ProfileSource,expectedRunId?:string) => {
    if (vpn.busy || manualStore.blocked) return;
    if (!target && (selectionNeedsChoice || isSelectionMissing())) {
      vpn.reportError(t("profileStorage.choose")); return;
    }
    const assertCurrent=profilePreparation();
    const ownerContext=expectedRunId??vpn.runId??"stopped";
    const source=target??(activeBundle?readySources.find(source=>source.profile_ref.kind==="ready"&&source.profile_ref.subscription_id===activeBundle.subscriptionId&&source.profile_ref.child_key===activeBundle.childKey)??null:profileSources[selectedIndex]??null);
    vpn.clearError();setSelectionBusy(true);
    try{
      const preparationId=("__TAURI_INTERNALS__" in window)?(await vpnBeginPreparation()).request:undefined;
      assertCurrent();
      if(source&&source.profile_ref.kind!=="manual")await api.validateSubscriptionSource(source);
      assertCurrent();
      if(source?.profile_ref.kind==="ready"||(!target&&activeBundle)){
        const ref=source?.profile_ref.kind==="ready"?source.profile_ref:{subscription_id:activeBundle!.subscriptionId,child_key:activeBundle!.childKey};
        const child=await api.getActiveChildConfig(ref.subscription_id,settings.routing,ref.child_key);
        if(child.child_key!==ref.child_key||(source&&child.source_revision!==source.source_revision))throw Error(t("profileEvidence.changed"));
        assertCurrent();
        await vpn.connect({engine:child.engine,config:child.config,name:child.child_name},child.child_name,{source,settings,expectedRunId:ownerContext,preparationId});
      }else{
        const index=target?findSourceIndex(profileSources,target):selectedIndex;
        if(target&&index<0)throw Error(t("profileEvidence.changed"));
        const picked=profiles[index];
        const attemptProfiles=picked?[picked,...profiles.filter((_,i)=>i!==index)]:profiles;
        const attemptSettings={...settings,default_outbound:picked&&isSupported(picked)?picked.tag:null};
        await vpn.connect(undefined,picked?profileLabel(picked):undefined,{source,profiles:attemptProfiles,settings:attemptSettings,expectedRunId:ownerContext,preparationId});
      }
    }catch(error){vpn.reportError(humanError(error)==="profile_source_changed"?t("profileEvidence.changed"):error,source,ownerContext)}
    finally{setSelectionBusy(false)}
  };
  const cardActions=useProfileErrorActions({
    contextKey:vpn.runId??"stopped",
    ownerContextKey:vpn.error?(vpn.errorContext??"stopped"):undefined,
    target:vpn.error?(vpn.errorSource??null):vpn.state==="error"?vpn.source??null:null,
    sources:allSources,disabled:vpn.busy,
    choose:()=>changeTab("servers"),refresh:subs.refreshOne,
    reconnect:async(_index,target)=>{await connectWithSelection(target,vpn.runId??"stopped")},
  });

  const dotCls =
    vpn.state === "running"
      ? "bg-theme-accent"
      : vpn.state === "starting"
        ? "bg-foreground animate-pulse-dot"
        : vpn.state === "error"
          ? "bg-red-400"
          : "bg-muted-foreground";

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Header: brand + live status capsule. */}
      <header className="flex shrink-0 items-center justify-between border-b border-border/40 bg-background/85 px-4 py-3 backdrop-blur-xl pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-xl bg-theme-subtle ring-1 ring-theme-accent">
            <img src={cloakwireLogo} alt="Cloakwire" className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-foreground">Cloakwire</h1>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-border/40 bg-card/80 px-2.5 py-1 backdrop-blur-md shadow-sm">
          <span className={cn("h-2 w-2 rounded-full", dotCls)} />
          <span className="text-[11px] font-mono text-muted-foreground">
            {vpn.state === "running"
              ? t("common.connected")
              : vpn.state === "starting"
                ? t("common.connecting")
                : vpn.state === "error"
                  ? t("common.error")
                  : t("common.disconnected")}
          </span>
        </div>
      </header>

      {/* Content */}
      <ProfileHealthContext.Provider value={{sources:allSources,evidence:vpn.profileCheck??null}}>
      <main
        ref={contentRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <ProfileImportDialog plan={profileImport.plan} records={manualRecords} error={profileImport.error} mobile onApply={profileImport.apply} onCancel={profileImport.cancel} />
      <ManualProfileStorageNotice state={manualStore.state} retry={manualStore.retry} reconcile={manualStore.reconcile} />
        {(selectionNeedsChoice || selectionMissing) && <p role="alert" className="m-3 text-sm">{t("profileStorage.choose")}</p>}
        {shouldShowReconnectNotice({
            reconnectInProgress,
            reconnectRequired,
            reconnectFailed,
            state: vpn.state,
          }) && (
          <div
            role="status"
            className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-theme-accent-subtle bg-theme-subtle px-4 py-2.5 backdrop-blur-md shadow-sm"
          >
            <span className="text-xs text-foreground/90">
              {reconnectInProgress
                ? t("common.reconnecting")
                : reconnectFailed
                  ? t("settings.reconnectFailed")
                  : t("settings.reconnectNotice")}
              {reconnectFailed && reconnectError && (
                <span
                  className="ml-2 block text-[11px] text-destructive/90"
                  title={profileCheckDetails(reconnectError, t)?.reason ?? reconnectError}
                >
                  {profileCheckDetails(reconnectError, t)?.reason ?? reconnectError}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void reconnect()}
              disabled={vpn.busy || reconnectInProgress}
              className="flex h-8 items-center gap-1.5 rounded-xl bg-theme-accent px-3 text-xs font-semibold text-zinc-950 shadow-sm transition active:scale-95 disabled:opacity-50"
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5",
                  (vpn.busy || reconnectInProgress) && "animate-spin",
                )}
              />
              {reconnectFailed ? t("common.retry") : t("settings.reconnectNow")}
            </button>
          </div>
        )}
        <div
          key={`${activeTab}:${logsOpen ? "logs" : "main"}`}
          className={`mobile-view-enter-${transitionDirection}`}
        >
          {activeTab === "home" && (
            <HomeScreen
              vpn={vpn}
              errorActions={<ProfileErrorActions {...cardActions}/>}
              profiles={profiles}
              groups={serverGroups}
              selectedIndex={selectedIndex}
              geoipByIp={geoip.byIp}
              settings={settings}
              onSelect={onSelectProfile}
              onOpenServers={() => changeTab("servers")}
              onOpenRouting={() => changeTab("routing")}
              activeBundle={activeBundle}
              onConnect={() => void connectWithSelection()}
              subs={subs.subs}
              onSelectBundleChild={(input) => {
                void onSelectBundleChild(input);
              }}
              onAddSub={async (input) => {
                try {
                  await subs.add(input);
                } finally {
                  markConnectionDirty();
                }
              }}
              onAddLinks={profileImport.request}
            />
          )}
          {activeTab === "servers" && (
            <ServersScreen
              profiles={profiles}
              groups={serverGroups}
              selectedIndex={selectedIndex}
              geoipByIp={geoip.byIp}
              onSelect={onSelectProfile}
              subs={subs.subs}
              subFetching={subs.fetching}
              lastResult={subs.lastResult}
              engine={vpn.engine}
              onAddSub={async (input) => {
                try {
                  await subs.add(input);
                } finally {
                  markConnectionDirty();
                }
              }}
              onAddLinks={profileImport.request}
              onRemoveSub={(id) => {
                subs.remove(id);
                markConnectionDirty();
              }}
              onRefreshSub={(id) => {
                void subs.refreshOne(id);
                markConnectionDirty();
              }}
              activeBundle={activeBundle}
              onSelectBundleChild={(input) => {
                void onSelectBundleChild(input);
              }}
              onRemoveManual={removeManualProfile}
            />
          )}
          {activeTab === "routing" && (
            <RoutingScreen settings={settings} onSettingsChange={setMobileSettings} />
          )}
          {activeTab === "settings" && logsOpen && (
            <LogsScreen
              onBack={() => {
                setTransitionDirection("previous");
                setLogsOpen(false);
              }}
            />
          )}
          {activeTab === "settings" && !logsOpen && (
            <SettingsScreen
              settings={settings}
              onSettingsChange={setMobileSettings}
              autoConnect={autoConnect}
              onAutoConnectChange={setAutoConnect}
              onRefreshAllSubs={() => {
                void subs.refreshAll();
                markConnectionDirty();
              }}
              subsFetching={Object.values(subs.fetching).some(Boolean)}
              onOpenLogs={() => {
                setTransitionDirection("next");
                setLogsOpen(true);
              }}
            />
          )}
        </div>
      </main>
      </ProfileHealthContext.Provider>

      {/* Bottom navigation. */}
      <nav className="shrink-0 border-t border-border/60 bg-card/95 backdrop-blur-2xl pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2xl">
        <div className="flex items-stretch px-2 pt-1.5">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = t.id === activeTab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => changeTab(t.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex flex-1 flex-col items-center gap-1 py-1.5 rounded-xl transition-all duration-200",
                  active
                    ? "text-theme-accent font-semibold"
                    : "text-muted-foreground hover:text-foreground/80 active:scale-95",
                )}
              >
                {active && (
                  <span className="absolute inset-0 rounded-xl bg-theme-subtle -z-10" />
                )}
                <Icon className={cn("h-5 w-5 transition-transform", active && "scale-110")} />
                <span className="text-[10px] tracking-tight">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

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
