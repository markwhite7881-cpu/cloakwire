// Bridge to the Android VPN plugin (Kotlin VpnService + libbox) and
// to the shared traffic commands. Desktop never imports this module —
// it drives the sing-box sidecar through `lib/api.ts` instead.
//
// The plugin commands are registered by the Kotlin side as
// `plugin:vpn|<command>`; the status event is emitted as "status".

import {
  addPluginListener,
  invoke,
  type PluginListener,
} from "@tauri-apps/api/core";

export type VpnState = "stopped" | "starting" | "running" | "error";

export interface VpnStatus {
  state: VpnState;
  message: string | null;
  since: number | null;
  /** Active engine name reported by the Kotlin service; empty when stopped. */
  engine: "sing-box" | "xray" | "";
}

export interface AppEntry {
  label: string;
  packageName: string;
  system: boolean;
  hasInternet: boolean;
}

/** Ask the OS for VPN permission. Resolves `{ prepared: false }`
 *  when the user declined (or the dialog is still pending). */
export const vpnPrepare = () =>
  invoke<{ prepared: boolean }>("plugin:vpn|prepare");

/**
 * Start the tunnel with a complete engine config JSON. Rust is the
 * source of truth: generated sing-box configs for manual/share-link
 * profiles and normalized provider configs for bundle children.
 *
 * Per-app routing travels in `apps` (package names) + `appsMode`
 * ("include" | "exclude"); the service always excludes its own
 * package regardless.
 */
export const vpnStart = (
  config: string,
  options: {
    engine?: "singbox" | "xray";
    apps?: string[];
    appsMode?: "include" | "exclude";
    /**
     * User-facing label of the picked server. Forwarded to the
     * Kotlin VPN service as `EXTRA_SERVER_NAME` so the Quick Settings
     * tile can show the real server name (e.g. "Germany #1") rather
     * than the internal xray outbound tag ("proxy", "out-0", ...).
     */
    name?: string;
  } = {},
) =>
  invoke<void>("plugin:vpn|start", {
    config,
    engine: options.engine ?? "singbox",
    apps: JSON.stringify(options.apps ?? []),
    appsMode: options.appsMode ?? "exclude",
    name: options.name ?? "",
  });

export const vpnStop = () => invoke<void>("plugin:vpn|stop");

export interface LatencyResult {
  tag: string;
  ms: number | null;
}

/**
 * Real end-to-end latency through each profile: the plugin spawns a
 * short-lived tester xray (spec built by `api.generateXrayTestConfig`)
 * and pulls generate_204 through every inbound. Works with the VPN up
 * and down.
 */
export const vpnTestLatency = async (
  config: unknown,
  entries: Array<{ tag: string; port: number }>,
): Promise<LatencyResult[]> => {
  const r = await invoke<{ results?: LatencyResult[] }>(
    "plugin:vpn|testLatency",
    { config: JSON.stringify(config), entries: JSON.stringify(entries) },
  );
  return r?.results ?? [];
};

export const vpnStatus = () => invoke<VpnStatus>("plugin:vpn|status");

/** Installed apps for the per-app routing picker.
 *  Kotlin resolves `{ apps: [...] }` — unwrap it here. */
export const vpnListApps = async (): Promise<AppEntry[]> => {
  const r = await invoke<{ apps?: AppEntry[] } | AppEntry[]>(
    "plugin:vpn|listApps",
  );
  if (Array.isArray(r)) return r;
  return r?.apps ?? [];
};

/** xray core version (binary probe, cached).
 *  Kotlin resolves `{ value: "..." }` — unwrap it here. */
export const vpnCoreVersion = async (): Promise<string> => {
  const r = await invoke<string | { value?: string }>(
    "plugin:vpn|coreVersion",
  );
  return typeof r === "string" ? r : (r?.value ?? "");
};

/** Tail of the core log ring buffer, one line per entry.
 *  Kotlin resolves `{ value: "..." }` — unwrap it here. */
export const vpnReadLogs = async (maxLines = 300): Promise<string> => {
  const r = await invoke<string | { value?: string }>("plugin:vpn|readLogs", {
    maxLines,
  });
  return typeof r === "string" ? r : (r?.value ?? "");
};

/** Subscribe to VPN state changes pushed by the service. */
export const onVpnStatus = (
  cb: (s: VpnStatus) => void,
): Promise<PluginListener> => addPluginListener("vpn", "status", cb);

