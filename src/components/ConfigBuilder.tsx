import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  FileCog,
  Loader2,
  Power,
  RotateCcw,
  Save,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
// `Play` removed in v0.3.1 — the Start button in this tab was
// confusing (cached config, separate path from the real Connect in
// App.tsx). Use the Home tab's Connect instead.
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import { Button } from "./Button";
import { Badge } from "./Badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./Card";
import { cn } from "@/lib/utils";
import { previewToSingboxJson } from "./previewConfig";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import { runLeakDiagnostics, type LeakTestResult } from "@/lib/leakTest";
import type { GeneratorSettings, KillSwitchMode, Outbound, TunnelMode } from "@/lib/types";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// DEFAULT_SETTINGS is imported from @/lib/defaults so this preview
// pane and the live app in App.tsx share the same defaults. v0.3.0
// had a local copy here that drifted to 1.1.1.1 while App.tsx was
// 77.88.8.8 — fixed by extracting to a shared module.

const TUNNEL_MODES: { value: TunnelMode; label: string; hint: string }[] = [
  {
    value: "tun",
    label: "TUN",
    hint: "System-wide (admin + Wintun)",
  },
  {
    value: "system_proxy",
    label: "System Proxy",
    hint: "HTTP/SOCKS system proxy",
  },
  {
    value: "both",
    label: "Both",
    hint: "TUN + local proxy",
  },
  {
    value: "none",
    label: "None",
    hint: "Outbounds only (testing)",
  },
];

const KILL_SWITCH_MODES: { value: KillSwitchMode; label: string; hint: string }[] = [
  {
    value: "off",
    label: "Выключен",
    hint: "Без блокировки сети",
  },
  {
    value: "on_drop",
    label: "При обрыве",
    hint: "Блокирует интернет при падении туннеля",
  },
  {
    value: "always_on",
    label: "Всегда активен",
    hint: "Блокирует весь трафик вне VPN",
  },
];

interface Props {
  profiles: Outbound[];
  /** Lifted from App so changes survive tab switches and restarts. */
  settings: GeneratorSettings;
  onSettingsChange: (next: GeneratorSettings) => void;
  /** Restore all settings to their defaults (Bypass LAN on, Reject IPv6
   *  on, everything else off, system_proxy, mixed_port 2080, etc.). */
  onResetSettings: () => void;
  onConfigPath: (path: string | null) => void;
}

export function ConfigBuilder({
  profiles,
  settings,
  onSettingsChange,
  onResetSettings,
  onConfigPath,
}: Props) {
  const [configText, setConfigText] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Windows autostart toggle.
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  useEffect(() => {
    if (!inTauri) return;
    api
      .getAutostart()
      .then(setAutostart)
      .catch(() => setAutostart(false));
  }, []);
  const toggleAutostart = async (next: boolean) => {
    setAutostartBusy(true);
    try {
      const actual = await api.setAutostart(next);
      setAutostart(actual);
      setInfo(
        actual
          ? "Will start with Windows. Use --minimized to skip showing the window."
          : "Autostart disabled.",
      );
    } catch (e) {
      setError((e as Error).message);
      setAutostart(!next);
    } finally {
      setAutostartBusy(false);
    }
  };

  const [testingLeaks, setTestingLeaks] = useState(false);
  const [leakResult, setLeakResult] = useState<LeakTestResult | null>(null);
  const [resettingFirewall, setResettingFirewall] = useState(false);
  const [firewallResetMsg, setFirewallResetMsg] = useState<string | null>(null);

  const handleTestLeaks = async () => {
    setTestingLeaks(true);
    setLeakResult(null);
    try {
      const res = await runLeakDiagnostics();
      setLeakResult(res);
    } catch (e) {
      setError(`Ошибка проверки утечек: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTestingLeaks(false);
    }
  };

  const handleResetFirewall = async () => {
    setResettingFirewall(true);
    try {
      await api.cleanupKillSwitch();
      setFirewallResetMsg("Правила брандмауэра успешно сброшены.");
    } catch (e) {
      setFirewallResetMsg(`Ошибка сброса: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResettingFirewall(false);
      setTimeout(() => setFirewallResetMsg(null), 4000);
    }
  };

  const update = <K extends keyof GeneratorSettings>(
    key: K,
    val: GeneratorSettings[K],
  ) => onSettingsChange({ ...settings, [key]: val });

  const onGenerate = async () => {
    setGenerating(true);
    setError(null);
    setInfo(null);
    try {
      let value: Record<string, unknown>;
      if (inTauri) {
        value = await api.generateConfig(profiles, settings);
      } else {
        value = previewToSingboxJson(profiles, settings);
      }
      const text = JSON.stringify(value, null, 2);
      setConfigText(text);
      onConfigPath(null);
      setInfo(
        profiles.length === 0
          ? "Generated skeleton (no profiles yet — add some and re-generate)."
          : `Generated config for ${profiles.length} profile${profiles.length === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const onCopy = async () => {
    if (!configText) return;
    try {
      await navigator.clipboard.writeText(configText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const onSave = async () => {
    if (!configText) return;
    setSaving(true);
    setError(null);
    try {
      const picked = await save({
        defaultPath: "config.json",
        filters: [
          { name: "sing-box config", extensions: ["json"] },
          { name: "All", extensions: ["*"] },
        ],
      });
      if (!picked) {
        setSaving(false);
        return;
      }
      let path: string;
      if (inTauri) {
        const value = JSON.parse(configText);
        path = await api.saveConfigToPath(value, picked);
      } else {
        // Browser preview: trigger a download.
        const blob = new Blob([configText], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = picked.split(/[\\/]/).pop() || "config.json";
        a.click();
        URL.revokeObjectURL(url);
        path = picked;
      }
      onConfigPath(path);
      setInfo(`Saved to ${path}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bento-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <FileCog className="h-4 w-4 text-emerald-400" />
            Config builder
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
              {profiles.length}
            </Badge>
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={onResetSettings}
            title="Reset all settings (tunnel mode, routing, DNS, port) to defaults"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
        <CardDescription>
          Bundles the parsed profiles into a sing-box config with TUN, DNS,
          routing and the Clash API. Generated from the profiles above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Tunnel mode picker */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Tunnel
          </p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {TUNNEL_MODES.map((m) => {
              const active = settings.tunnel_mode === m.value;
              return (
                <button
                  key={m.value}
                  onClick={() => update("tunnel_mode", m.value)}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left transition-colors",
                    active
                      ? "border-foreground/30 bg-foreground/5"
                      : "border-border bg-card/30 hover:bg-accent",
                  )}
                  title={m.hint}
                >
                  <div className="text-xs font-medium">{m.label}</div>
                  <div className="text-[9px] text-muted-foreground">
                    {m.hint}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Routing lives on the dedicated "Routing" tab (Routing 2.0).
            This block now only contains network/transport + DNS settings. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2 rounded-md border border-border bg-card/30 px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">Mixed port</span>
            <input
              type="number"
              min={1}
              max={65535}
              className="ml-auto w-20 rounded border border-input bg-background px-2 py-0.5 font-mono text-[11px]"
              value={settings.mixed_port ?? 2080}
              onChange={(e) =>
                update(
                  "mixed_port",
                  e.target.value ? parseInt(e.target.value, 10) : null,
                )
              }
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border border-border bg-card/30 px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">TUN interface</span>
            <input
              type="text"
              placeholder="singbox-tun"
              className="ml-auto w-44 truncate rounded border border-input bg-background px-2 py-0.5 font-mono text-[11px]"
              value={settings.tun_interface_name ?? ""}
              onChange={(e) =>
                update("tun_interface_name", e.target.value || null)
              }
              title="Leave blank for the sing-box default ('singbox-tun' on most platforms)"
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border border-border bg-card/30 px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">Local DNS</span>
            <input
              type="text"
              placeholder="1.1.1.1"
              className="ml-auto w-44 truncate rounded border border-input bg-background px-2 py-0.5 font-mono text-[11px]"
              value={settings.local_dns ?? ""}
              onChange={(e) =>
                update("local_dns", e.target.value || null)
              }
              title="Plain-UDP DNS server (e.g. 1.1.1.1, 8.8.8.8). Avoid hostnames — they require a working DNS to resolve, which is exactly what this server is supposed to provide."
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border border-border bg-card/30 px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">Remote DNS</span>
            <input
              type="text"
              placeholder="https://8.8.8.8/dns-query"
              className="ml-auto w-44 truncate rounded border border-input bg-background px-2 py-0.5 font-mono text-[11px]"
              value={settings.remote_dns ?? ""}
              onChange={(e) =>
                update("remote_dns", e.target.value || null)
              }
              title="DoH / DoT / DoQ endpoint. Resolved through the proxy. IP form is safer than a hostname."
            />
          </label>
        </div>

        {/* Security & Privacy */}
        <div className="space-y-3 rounded-lg border border-border/80 bg-card/20 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
              <ShieldCheck className="h-4 w-4" />
              <span>Безопасность и защита от утечек</span>
            </div>
            <button
              type="button"
              onClick={handleResetFirewall}
              disabled={resettingFirewall}
              className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
              title="Экстренный сброс правил брандмауэра Windows"
            >
              {resettingFirewall ? "Сброс..." : "Сбросить файрвол"}
            </button>
          </div>

          {firewallResetMsg && (
            <div className="rounded border border-emerald-500/30 bg-emerald-950/40 p-2 text-xs text-emerald-300">
              {firewallResetMsg}
            </div>
          )}



          {/* Leak Diagnostics */}
          <div className="pt-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Диагностика утечек (IP, DNS, WebRTC):
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={handleTestLeaks}
                disabled={testingLeaks}
                className="h-7 text-xs"
              >
                {testingLeaks ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    Тестирование...
                  </>
                ) : (
                  <>
                    <Shield className="mr-1.5 h-3 w-3" />
                    Проверить утечки
                  </>
                )}
              </Button>
            </div>

            {leakResult && (
              <div
                className={cn(
                  "mt-2 rounded-lg border p-2.5 text-xs space-y-1.5",
                  leakResult.verdict === "protected"
                    ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-300"
                    : leakResult.verdict === "leaking"
                      ? "border-destructive/50 bg-destructive/15 text-destructive"
                      : "border-border bg-card/40 text-foreground",
                )}
              >
                <div className="flex items-center justify-between font-semibold">
                  <span>
                    {leakResult.verdict === "protected"
                      ? "✓ Защищен: утечек не обнаружено"
                      : leakResult.verdict === "leaking"
                        ? "⚠ Внимание: Обнаружена утечка данных!"
                        : "Результат проверки"}
                  </span>
                  <span className="text-[10px] font-mono opacity-70">
                    {new Date(leakResult.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-[11px] space-y-0.5 text-foreground/90">
                  <div>
                    <span className="text-muted-foreground">Внешний IP:</span>{" "}
                    <span className="font-mono font-medium">{leakResult.publicIp}</span> ({leakResult.country}, {leakResult.isp})
                  </div>
                  {leakResult.dnsServer && (
                    <div>
                      <span className="text-muted-foreground">DNS:</span>{" "}
                      <span className="font-mono">{leakResult.dnsServer}</span>
                    </div>
                  )}
                  {leakResult.webrtcIps.length > 0 && (
                    <div>
                      <span className="text-muted-foreground">WebRTC IP:</span>{" "}
                      <span className="font-mono">{leakResult.webrtcIps.join(", ")}</span>
                    </div>
                  )}
                </div>
                {leakResult.details.length > 0 && (
                  <ul className="text-[10px] space-y-0.5 opacity-85 list-disc pl-3 pt-0.5">
                    {leakResult.details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        {/*         <div className="rounded-md border border-border bg-card/30 px-2 py-1.5 text-xs">
          <div className="flex items-center gap-2">
            <Power className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1">Start with Windows (autostart)</span>
            <button
              type="button"
              onClick={() =>
                autostart !== null && toggleAutostart(!autostart)
              }
              disabled={!inTauri || autostart === null || autostartBusy}
              className={cn(
                // Slightly wider track (40px) so the 16px knob has
                // symmetric 2px gutters on both sides when "on" —
                // the previous 36px / translate-x-4 left a 6 px
                // gap on the right that read as "knob floats
                // outside" and made the active state look broken.
                "relative h-5 w-10 rounded-full border transition-colors",
                autostart
                  ? "border-foreground/30 bg-foreground/20"
                  : "border-border bg-foreground/5",
                (!inTauri || autostart === null || autostartBusy) &&
                  "opacity-50",
              )}
              title={
                !inTauri
                  ? "Autostart is only available in the Tauri build"
                  : autostart === null
                    ? "Loading…"
                    : autostart
                      ? "Disable autostart (writes to HKCU\\…\\Run)"
                      : "Enable autostart"
              }
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-foreground transition-all duration-200",
                  autostart ? "left-[22px]" : "left-0.5",
                )}
              />
            </button>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Writes/clears HKCU\Software\Microsoft\Windows\CurrentVersion\Run
            {autostart ? " — currently enabled" : " — currently disabled"}.
            Not available in browser preview.
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={onGenerate}
            disabled={generating}
            className="flex-1"
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Settings2 className="h-3.5 w-3.5" />
            )}
            Generate
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onSave}
            disabled={!configText || saving}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onCopy}
            disabled={!configText}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            Copy
          </Button>
        </div>

        <p className="text-[10px] text-muted-foreground">
          Start the tunnel from the <span className="font-medium">Home</span> tab
          (Connect button). The Config tab is for editing the
          generated config and exporting it.
        </p>

        {error && (
          <p className="text-[11px] text-destructive">{error}</p>
        )}
        {info && (
          <p className="text-[11px] text-muted-foreground">{info}</p>
        )}

        {/* Preview JSON */}
        {configText && (
          <div className="overflow-hidden rounded border border-border bg-background/50">
            <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed text-foreground/80">
              {configText}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
