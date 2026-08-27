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
import { useGeoIp } from "@/hooks/useGeoIp";
import { useSubscriptions } from "@/hooks/useSubscriptions";
import { loadManualProfiles, saveManualProfiles } from "@/lib/manualProfiles";
import { isSupported } from "@/lib/outbound";
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
import { HomeScreen } from "./screens/HomeScreen";
import { ServersScreen } from "./screens/ServersScreen";
import { RoutingScreen } from "./screens/RoutingScreen";
import { LogsScreen } from "./screens/LogsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
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

/** Best-effort string extraction for an unknown thrown value —
 *  used by the reconnect banner to render the failure reason.
 *  Mirrors the `humanError` helper that lives in `useVpnConnection.ts`
 *  and `App.tsx`. 2026-08-21. */
function humanError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || String(e);
  if (
    e &&
    typeof e === "object" &&
    typeof (e as { message?: unknown }).message === "string"
  ) {
    return (e as { message: string }).message;
  }
  return String(e);
}
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
  const [activeTab, setActiveTab] = useState<TabId>(readStoredTab);
  const [logsOpen, setLogsOpen] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState<"previous" | "next">("next");
  const [settings, setSettings] = useState<GeneratorSettings>(loadSettings);
  const [autoConnect, setAutoConnect] = useState<boolean>(loadAutoConnect);
  const [manualProfiles, setManualProfiles] = useState<Outbound[]>(() =>
    loadManualProfiles(),
  );
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
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
  useEffect(() => saveManualProfiles(manualProfiles), [manualProfiles]);
  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_KEY, activeTab);
    } catch {
      /* ignore */
    }
  }, [activeTab]);

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
    () => buildGroupedServerProfiles(manualProfiles, subs.subs, effectiveLastResult),
    [manualProfiles, subs.subs, effectiveLastResult],
  );

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

  const vpn = useVpnConnection(connectionProfiles, settings);

  const markConnectionDirty = () => {
    setReconnectRequired((previous) => nextReconnectRequired(previous, vpn.state));
  };

  // ---- Last-connected-server persistence ------------------------------
  // Saved when a connect reaches "running", restored on the next
  // cold start so the UI (and auto-connect) points at the server the
  // user actually used instead of `profiles[0]`.

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
    if (vpn.state !== "running") return;
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
      saveLastServer({ kind: "profile", tag: tagOf(picked) });
    }
  }, [vpn.state]);

  // Restore: the pick may reference a subscription outbound that
  // only appears once hydration finishes, so keep trying while the
  // list settles; a 5s timeout gives up so auto-connect is never
  // blocked forever. `restoreSettled` also gates the auto-connect
  // effect below — it must not fire with the default selection
  // while the real pick is still being located.
  const [restoreSettled, setRestoreSettled] = useState(false);
  const [restorePick] = useState(() => loadLastServer());
  const restoreAttempted = useRef(false);
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
    const index = profiles.findIndex((p) => tagOf(p) === pick.tag);
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
        setRestoreSettled(true);
      }
    }, 5000);
    return () => window.clearTimeout(t);
  }, []);
  // ----------------------------------------------------------------------

  // Remove a manual profile by tag (tags are unique in the built
  // list - duplicates get an `@endpoint` suffix). Selection follows
  // the same profile by tag across the rebuild.
  const removeManualProfile = (tag: string) => {
    const selectedTag =
      selectedIndex >= 0 && selectedIndex < profiles.length
        ? tagOf(profiles[selectedIndex])
        : null;
    const nextManual = manualProfiles.filter((p) => tagOf(p) !== tag);
    setManualProfiles(nextManual);
    if (selectedTag === tag) {
      setSelectedIndex(-1);
    } else if (selectedTag != null) {
      const rebuilt = buildGroupedServerProfiles(
        nextManual,
        subs.subs,
        effectiveLastResult,
      );
      const nextIndex = rebuilt.profiles.findIndex(
        (p) => ("tag" in p ? p.tag : p.raw) === selectedTag,
      );
      setSelectedIndex(nextIndex);
    }
    markConnectionDirty();
  };

  const setMobileSettings = (next: GeneratorSettings) => {
    setSettings(next);
    markConnectionDirty();
  };

  const reconnect = async () => {
    if (vpn.busy || reconnectInProgress) return;
    setReconnectInProgress(true);
    setReconnectFailed(false);
    setReconnectError(null);
    try {
      if (vpn.state === "running") {
        reconnectPhase.current = "disconnecting";
        await vpn.disconnect();
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      reconnectPhase.current = "connecting";
      // Reconnect honours the current active selection — bundle
      // child picks survive reconnects. 2026-08-20.
      await connectWithSelection();
    } catch (e) {
      reconnectPhase.current = "idle";
      setReconnectInProgress(false);
      setReconnectFailed(true);
      // `e` may be an Error, a TauriCommandError-like object with
      // `{ message }`, or anything else thrown by the IPC layer.
      // Normalise to a string so the banner can render it.
      setReconnectError(humanError(e));
    }
  };

  useEffect(() => {
    if (reconnectPhase.current !== "connecting") return;
    if (vpn.state === "running") {
      reconnectPhase.current = "idle";
      setReconnectInProgress(false);
      setReconnectRequired(false);
      setReconnectFailed(false);
      setReconnectError(null);
    } else if (vpn.state === "error" || vpn.error) {
      reconnectPhase.current = "idle";
      setReconnectInProgress(false);
      setReconnectFailed(true);
      // Surface whatever the VPN service reported as the failure
      // reason; fall back to the existing `vpn.error` if the
      // exception didn't carry a message.
      setReconnectError(vpn.error ?? "VPN failed to start.");
    }
  }, [vpn.error, vpn.state]);

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
    restoreSettled,
    vpn.ready,
    vpn.state,
    profiles.length,
    activeBundle,
    vpn.connect,
  ]);

  // Clamp the selection when the list shrinks. `-1` is the "Auto"
  // (urltest) pick and is valid even when the list is non-empty —
  // use the shared `isValidProfileSelection` helper so the mobile
  // clamp matches the desktop behaviour. 2026-08-21.
  useEffect(() => {
    if (profiles.length === 0 && selectedIndex !== -1) setSelectedIndex(-1);
    else if (
      profiles.length > 0 &&
      !isValidProfileSelection(selectedIndex, profiles.length)
    ) {
      setSelectedIndex(0);
    }
  }, [profiles.length, selectedIndex]);

  const onSelectProfile = (index: number) => {
    const isAuto = index === -1;
    let pickedTag: string | null = null;
    if (!isAuto) {
      const p = profiles[index];
      if (!p || !isSupported(p)) return;
      pickedTag = p.tag;
    }
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
    setActiveBundle(input);
    setSelectedIndex(-1);
    // setMobileSettings already calls markConnectionDirty — the
    // next connect uses the new bundle pick, so the user needs
    // the reconnect banner.
    setMobileSettings({ ...settings, default_outbound: null });
  };

  // Wrapped connect: if a bundle child is selected, fetch its full
  // engine config from Rust and hand it to the Kotlin service
  // (bypassing the global engine and the share-link generator).
  // Otherwise fall through to the normal share-link flow. 2026-08-20.
  const connectWithSelection = async () => {
    if (activeBundle) {
      try {
        const child = await api.getActiveChildConfig(activeBundle.subscriptionId);
        if (child.child_key !== activeBundle.childKey) {
          // Stale — Rust doesn't have the same active child any
          // more. Drop our cached selection and reconnect via
          // the share-link path instead.
          setActiveBundle(null);
          await vpn.connect();
          return;
        }
        await vpn.connect(
          {
            // Rust `EngineKind` wire value: "singbox" | "xray".
            // Each child starts with the engine declared by its provider.
            engine: child.engine,
            config: child.config,
            // Friendly child name — surfaces in the Quick Settings
            // tile instead of a generic config tag ("proxy", ...).
            name: activeBundle.childName,
          },
          activeBundle.childName,
        );
      } catch (e) {
        // Rust rejected the lookup (no active child, bundle no
        // longer present, etc.). Fall back to the share-link
        // path and clear our cached selection.
        setActiveBundle(null);
        await vpn.connect();
      }
    } else {
      // Share-link path. `vpn.connect` derives the name from the
      // first supported profile (mirrors what the Home headline
      // would show), so the tile label matches the UI.
      await vpn.connect();
    }
  };

  const dotCls =
    vpn.state === "running"
      ? "bg-emerald-400"
      : vpn.state === "starting"
        ? "bg-foreground animate-pulse-dot"
        : vpn.state === "error"
          ? "bg-red-400"
          : "bg-muted-foreground";

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Header: brand + live status dot. */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card/40 px-4 py-2.5 backdrop-blur pt-[max(0.625rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md bg-primary/15 ring-1 ring-primary/30">
            <img src={cloakwireLogo} alt="Cloakwire" className="h-5 w-5" />
          </div>
          <h1 className="text-sm font-semibold tracking-tight">Cloakwire</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", dotCls)} />
          <span className="text-[11px] text-muted-foreground">
            {vpn.state === "running"
              ? "Connected"
              : vpn.state === "starting"
                ? "Connecting"
                : vpn.state === "error"
                  ? "Error"
                  : "Offline"}
          </span>
        </div>
      </header>

      {/* Content */}
      <main
        ref={contentRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {shouldShowReconnectNotice({
            reconnectInProgress,
            reconnectRequired,
            reconnectFailed,
            state: vpn.state,
          }) && (
          <div
            role="status"
            className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-primary/20 bg-primary/5 px-4 py-2 shadow-sm"
          >
            <span className="text-xs text-foreground/80">
              {reconnectInProgress
                ? "Reconnecting VPN…"
                : reconnectFailed
                  ? "Reconnect failed. Try again to apply changes."
                  : "Settings saved. Reconnect the VPN to apply changes."}
              {reconnectFailed && reconnectError && (
                <span
                  className="ml-2 block text-[11px] text-destructive/90"
                  title={reconnectError}
                >
                  {reconnectError}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void reconnect()}
              disabled={vpn.busy || reconnectInProgress}
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground active:bg-primary/90 disabled:opacity-50"
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5",
                  (vpn.busy || reconnectInProgress) && "animate-spin",
                )}
              />
              {reconnectFailed ? "Retry" : "Reconnect"}
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
              onAddLinks={(obs) => {
                setManualProfiles((prev) => [...obs, ...prev]);
                markConnectionDirty();
              }}
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

      {/* Bottom navigation. */}
      <nav className="shrink-0 border-t border-border bg-card/60 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-stretch">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = t.id === activeTab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => changeTab(t.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-1 flex-col items-center gap-0.5 py-2 transition-colors",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground active:text-foreground/80",
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[10px] font-medium">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
