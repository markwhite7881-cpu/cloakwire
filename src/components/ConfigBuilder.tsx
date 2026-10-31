import {RecoverySetting} from "@/components/RecoverySettings";
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
import { useI18n } from "@/lib/i18n";
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
  const { t } = useI18n();
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
          ? t("config.skeletonGenerated")
          : t("config.configGenerated", { count: profiles.length }),
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
      setInfo(t("config.savedTo", { path }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const tunnelModes: { value: TunnelMode; label: string; hint: string }[] = [
    {
      value: "tun",
      label: "TUN",
      hint: t("config.tunHint"),
    },
    {
      value: "system_proxy",
      label: t("home.systemProxy"),
      hint: t("config.systemProxyHint"),
    },
    {
      value: "both",
      label: t("common.both"),
      hint: t("config.bothHint"),
    },
    {
      value: "none",
      label: t("common.none"),
      hint: t("config.noneHint"),
    },
  ];

  return (
    <Card className="bento-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <FileCog className="h-4 w-4 text-theme-accent" />
            {t("config.builderTitle")}
            <Badge variant="secondary" className="badge-theme ml-1 px-1.5 py-0 text-[10px]">
              {profiles.length}
            </Badge>
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={onResetSettings}
            title={t("config.resetTooltip")}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("config.resetBtn")}
          </Button>
        </div>
        <CardDescription>
          {t("config.builderDesc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <RecoverySetting />
        {/* Tunnel mode picker */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("config.tunnelMode")}
          </p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {tunnelModes.map((m) => {
              const active = settings.tunnel_mode === m.value;
              return (
                <button
                  key={m.value}
                  onClick={() => update("tunnel_mode", m.value)}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left transition-colors",
                    active
                      ? "border-theme-accent bg-theme-subtle text-foreground shadow-sm"
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
            <span className="text-muted-foreground">{t("config.mixedPort")}</span>
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
            <span className="text-muted-foreground">{t("config.tunInterface")}</span>
            <input
              type="text"
              placeholder="singbox-tun"
              className="ml-auto w-44 truncate rounded border border-input bg-background px-2 py-0.5 font-mono text-[11px]"
              value={settings.tun_interface_name ?? ""}
              onChange={(e) =>
                update("tun_interface_name", e.target.value || null)
              }
              title={t("config.tunInterfaceHint")}
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border border-border bg-card/30 px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">{t("config.localDns")}</span>
            <input
              type="text"
              placeholder="1.1.1.1"
              className="ml-auto w-44 truncate rounded border border-input bg-background px-2 py-0.5 font-mono text-[11px]"
              value={settings.local_dns ?? ""}
              onChange={(e) =>
                update("local_dns", e.target.value || null)
              }
              title={t("config.localDnsHint")}
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border border-border bg-card/30 px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">{t("config.remoteDns")}</span>
            <input
              type="text"
              placeholder="https://8.8.8.8/dns-query"
              className="ml-auto w-44 truncate rounded border border-input bg-background px-2 py-0.5 font-mono text-[11px]"
              value={settings.remote_dns ?? ""}
              onChange={(e) =>
                update("remote_dns", e.target.value || null)
              }
              title={t("config.remoteDnsHint")}
            />
          </label>
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
            {t("config.generate")}
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
            {t("common.save")}
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
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </div>

        <p className="text-[10px] text-muted-foreground">
          {t("config.startNotice")}
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
