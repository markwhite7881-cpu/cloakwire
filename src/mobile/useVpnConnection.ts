import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  onVpnStatus,
  vpnPrepare,
  vpnStart,
  vpnStatus,
  vpnStop,
  type VpnState,
  type VpnStatus,
} from "@/lib/vpn";
import type { GeneratorSettings, Outbound } from "@/lib/types";
import { isSupported, profileLabel } from "@/lib/outbound";
import type { MobileEngine } from "@/mobile/lib/settings";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface VpnConnection {
  /** Last known VPN state (drives the button + status dot). */
  state: VpnState;
  /** Error/info message from the service (state === "error"). */
  message: string | null;
  /** Epoch ms when the current state began (for uptime). */
  since: number | null;
  /**
   * Active engine name reported by the Kotlin service. Empty when
   * no session is running or before the first status read.
   */
  engine: VpnStatus["engine"];
  /** False until the initial `vpnStatus()` call resolves. */
  ready: boolean;
  /** True while a connect/disconnect action is in flight. */
  busy: boolean;
  /** Human-readable failure of the last action, if any. */
  error: string | null;
  /**
   * Start the VPN. Pass `override` to feed a pre-built engine config
   * straight into the Kotlin service — used by the bundle child picker
   * where each child carries its own engine.
   *
   * `name` is the user-facing label of the picked server (or bundle
   * child) — propagated through to the Kotlin service so the Quick
   * Settings tile can show "Germany #1" instead of a generic outbound
   * tag. Optional.
   */
  connect: (override?: BundleChildOverride, name?: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

/** Engine configuration of a bundle subscription's active child. */
export interface BundleChildOverride {
  /** Engine declared by the provider child. */
  engine: MobileEngine;
  /** Full engine config as a JSON string, passed to the Kotlin
   *  service verbatim. */
  config: string;
  /** User-facing label of the child (shown in the Quick Settings
   *  tile). Optional — falls back to a config-derived tag if absent. */
  name?: string;
}

function humanError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Mobile connect flow — mirrors the desktop engine selection while the
 * Kotlin VpnService owns each engine's Android lifecycle:
 *
 *   1. vpnPrepare() — request Android VPN permission when needed.
 *   2. Use the ready bundle child's config, or generate a sing-box config
 *      for manual/share-link profiles.
 *   3. vpnStart() — start the selected engine and establish its TUN path.
 *
 * Disconnect stops whichever engine is active.
 */
export function useVpnConnection(
  profiles: Outbound[],
  settings: GeneratorSettings,
): VpnConnection {
  const [status, setStatus] = useState<VpnStatus>({
    state: "stopped",
    message: null,
    since: null,
    engine: "",
  });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest profiles/settings for the async connect closure.
  const profilesRef = useRef(profiles);
  const settingsRef = useRef(settings);
  useEffect(() => {
    profilesRef.current = profiles;
    settingsRef.current = settings;
  }, [profiles, settings]);

  // Initial status (survives activity recreation — the service keeps
  // running when the WebView is torn down) + live subscription.
  useEffect(() => {
    if (!inTauri) {
      setReady(true);
      return;
    }
    let cancelled = false;
    let listener: { unregister: () => Promise<void> } | null = null;
    (async () => {
      try {
        const s = await vpnStatus();
        if (!cancelled) setStatus(s);
      } catch (e) {
        if (!cancelled) setError(humanError(e));
      } finally {
        if (!cancelled) setReady(true);
      }
      try {
        const l = await onVpnStatus((s) => setStatus(s));
        if (cancelled) {
          void l.unregister();
        } else {
          listener = l;
        }
      } catch (e) {
        if (!cancelled) setError(humanError(e));
      }
    })();
    return () => {
      cancelled = true;
      if (listener) void listener.unregister();
    };
  }, []);

  const connect = useCallback(async (override?: BundleChildOverride, name?: string) => {
    setError(null);
    // Browser preview (?mobile=1 outside Tauri): fake the state so
    // the UI is demoable.
    if (!inTauri) {
      setBusy(true);
      setStatus({ state: "starting", message: null, since: Date.now(), engine: "sing-box" });
      await new Promise((r) => setTimeout(r, 600));
      setStatus({ state: "running", message: null, since: Date.now(), engine: "sing-box" });
      setBusy(false);
      return;
    }
    // Bundle children come with a pre-built engine config — pass it
    // through verbatim. Share-link paths still need at least one
    // profile to pick from.
    if (!override && profilesRef.current.length === 0) {
      setError("Add a server first (Servers tab).");
      return;
    }
    setBusy(true);
    try {
      // 1. VPN permission (Android shows the system dialog on the
      //    first call; resolves prepared=false when declined).
      const { prepared } = await vpnPrepare();
      if (!prepared) {
        setError("VPN permission required.");
        return;
      }
      // 2. Payload. Two paths:
      //    a) Bundle child: the provider config verbatim (Rust already
      //       spliced the protected dialer into it).
      //    b) Share-link / manual: Rust builds the sing-box config
      //       from the selected Outbound[] and generator settings.
      let config: string;
      let engine: MobileEngine;
      if (override) {
        engine = override.engine;
        config = override.config;
      } else {
        // Match desktop behavior: manual and share-link profiles run
        // through sing-box. Ready bundle children carry their own engine.
        engine = "singbox";
        config = JSON.stringify(
          await api.generateConfig(profilesRef.current, settingsRef.current),
        );
      }
      // 3. Per-app routing (Android only): include/exclude package
      //    lists from the Routing screen.
      const routing = settingsRef.current.routing ?? {};
      const appsMode =
        routing.tun_app_mode === "include" || routing.tun_app_mode === "exclude"
          ? routing.tun_app_mode
          : "exclude";
      const apps =
        routing.tun_app_mode === "all" ? [] : (routing.tun_app_list ?? []);
      // 4. User-facing label of the picked server. For bundle
      //    children the override carries it. For the share-link
      //    path the caller can pass it explicitly, otherwise we
      //    fall back to the first supported profile's label
      //    (the same one the Home headline would show).
      const resolvedName =
        name?.trim() ||
        override?.name?.trim() ||
        (() => {
          const supported = profilesRef.current.find(isSupported);
          return supported ? profileLabel(supported) : "";
        })();
      // 5. Hand off to the VpnService.
      await vpnStart(config, { engine, apps, appsMode, name: resolvedName });
      // No shared Clash API traffic stream on Android; byte counters
      // come from the VpnService notification instead.
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setError(null);
    if (!inTauri) {
      setStatus({ state: "stopped", message: null, since: Date.now(), engine: "" });
      return;
    }
    setBusy(true);
    try {
      await vpnStop();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    state: status.state,
    message: status.message,
    since: status.since,
    engine: status.engine,
    ready,
    busy,
    error,
    connect,
    disconnect,
  };
}
