import { Button } from "@/components/Button";
import { AtlasHeading } from "@/components/atlas/AtlasHeading";
import {RecoverySetting} from "@/components/RecoverySettings";
import { APP_VERSION } from "@/lib/appVersion";
import { useEffect, useState } from "react";
import { RefreshCw, Terminal, Settings2 } from "lucide-react";
import { api } from "@/lib/api";
import { vpnCoreVersion } from "@/lib/vpn";
import { cn } from "@/lib/utils";
import type { CustomRule, GeneratorSettings, KillSwitchMode, RoutingOptions } from "@/lib/types";
import { newRuleId } from "@/lib/presets";
import { SectionCard, SectionHeader, SettingRow } from "../components/SectionCard";
import { AtlasSwitch } from "@/components/atlas/AtlasSwitch";
import { type MobileEngine } from "@/mobile/lib/settings";
import { AccentThemePicker } from "@/components/AccentThemePicker";
import { LanguagePicker } from "@/components/LanguagePicker";
import { useI18n } from "@/lib/i18n";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** DNS provider presets — write both local and remote upstreams. */

const DNS_PRESETS: { id: string; label: string; local: string; remote: string }[] = [
  {
    id: "cloudflare",
    label: "Cloudflare (1.1.1.1)",
    local: "1.1.1.1",
    remote: "https://1.1.1.1/dns-query",
  },
  {
    id: "google",
    label: "Google (8.8.8.8)",
    local: "8.8.8.8",
    remote: "https://dns.google/dns-query",
  },
  {
    id: "quad9",
    label: "Quad9 (9.9.9.9)",
    local: "9.9.9.9",
    remote: "https://dns.quad9.net/dns-query",
  },
  {
    id: "yandex",
    label: "Yandex (77.88.8.8)",
    local: "77.88.8.8",
    remote: "https://8.8.8.8/dns-query",
  },
];

const IPV6_RULE_LABEL = "Reject IPv6";


function isIpv6RejectRule(rule: CustomRule): boolean {
  return (
    rule.action.kind === "reject" &&
    rule.matchers.ip_version === 6 &&
    Object.keys(rule.matchers).length === 1
  );
}

export function SettingsScreen({
  settings,
  onSettingsChange,
  autoConnect,
  onAutoConnectChange,
  onRefreshAllSubs,
  subsFetching,
  onOpenLogs,
}: {
  settings: GeneratorSettings;
  onSettingsChange: (next: GeneratorSettings) => void;
  autoConnect: boolean;
  onAutoConnectChange: (v: boolean) => void;
  onRefreshAllSubs: () => void;
  subsFetching: boolean;
  onOpenLogs: () => void;
}) {
  const { t } = useI18n();
  const update = (patch: Partial<GeneratorSettings>) =>
    onSettingsChange({ ...settings, ...patch });
  const updateRouting = (patch: Partial<RoutingOptions>) =>
    onSettingsChange({
      ...settings,
      routing: { ...settings.routing, ...patch },
    });

  const [coreVersion, setCoreVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    vpnCoreVersion()
      .then((v) => {
        if (!cancelled) setCoreVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // IPv6 switch: presence of an enabled reject-ip_version:6 rule.
  const ipv6Blocked = settings.routing.rules.some(
    (r) => isIpv6RejectRule(r) && r.enabled,
  );
  const setIpv6Blocked = (blocked: boolean) => {
    update({ block_ipv6: blocked });
    const rules = settings.routing.rules;
    if (blocked) {
      if (ipv6Blocked) return;
      updateRouting({
        rules: [
          ...rules,
          {
            id: newRuleId(),
            label: IPV6_RULE_LABEL,
            enabled: true,
            matchers: { ip_version: 6 },
            action: { kind: "reject" },
          },
        ],
      });
    } else {
      updateRouting({ rules: rules.filter((r) => !isIpv6RejectRule(r)) });
    }
  };


  // Remote rule-sets switch: enables/disables every remote rule-set.
  const ruleSets = settings.routing.rule_sets;
  const remoteSets = ruleSets.filter((rs) => rs.type === "remote");
  const remoteEnabled =
    remoteSets.length > 0 && remoteSets.every((rs) => rs.enabled);
  const setRemoteEnabled = (v: boolean) =>
    updateRouting({
      rule_sets: ruleSets.map((rs) =>
        rs.type === "remote" ? { ...rs, enabled: v } : rs,
      ),
    });

  const dnsPreset =
    DNS_PRESETS.find(
      (p) => p.local === settings.local_dns && p.remote === settings.remote_dns,
    )?.id ?? "custom";


  return (
    <div className="atlas-page atlas-settings">
      <AtlasHeading icon={Settings2} title={t("settings.title")}/>
      <SectionCard id="atlas-android-connection" tabIndex={-1}>
        <SectionHeader title={t("atlas.connection")} />
        <div className="divide-y divide-border">
          <RecoverySetting />
          <SettingRow
            label={t("settings.autoConnect")}
            hint={t("atlas.atLaunch")}
            control={
              <AtlasSwitch
                checked={autoConnect}
                onChange={onAutoConnectChange}
                label={t("settings.autoConnect")}
              />
            }
          />
          <SettingRow
            label={t("settings.remoteRuleSets")}
            hint={
              remoteSets.length === 0
                ? t("settings.noRemoteRuleSets")
                : t("settings.remoteRuleSetsHint", { count: remoteSets.length })
            }
            control={
              <AtlasSwitch
                checked={remoteEnabled}
                onChange={setRemoteEnabled}
                disabled={remoteSets.length === 0}
                label={t("settings.remoteRuleSets")}
              />
            }
          />
        </div>
      </SectionCard>

      <SectionCard id="atlas-android-appearance" tabIndex={-1}>
        <SectionHeader title={t("settings.appearance")} />
        <div className="atlas-preferences">
          <LanguagePicker />
          <AccentThemePicker />
        </div>
      </SectionCard>



      <SectionCard id="atlas-android-network" tabIndex={-1}>
        <SectionHeader title={t("settings.network")} />
        <div className="divide-y divide-border">
          <SettingRow
            label={t("settings.dnsProvider")}
            control={
              <select
                value={dnsPreset}
                onChange={(e) => {
                  const p = DNS_PRESETS.find((x) => x.id === e.target.value);
                  if (p) update({ local_dns: p.local, remote_dns: p.remote });
                }}
                className="atlas-input max-w-[180px]"
              >
                {DNS_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                {dnsPreset === "custom" && (
                  <option value="custom">{t("common.custom")}</option>
                )}
              </select>
            }
          />
          <SettingRow
            label={t("common.port")}
            hint={t("settings.mixedPortHint")}
            control={
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={settings.mixed_port ?? 2080}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= 65535) {
                    update({ mixed_port: n });
                  }
                }}
                className="atlas-input w-24 text-right"
              />
            }
          />
        </div>
      </SectionCard>

      {inTauri && <DeviceHwidSection />}

      <SectionCard id="atlas-android-about" tabIndex={-1}>
        <SectionHeader title={t("settings.about")} />
        <div className="divide-y divide-border">
          <SettingRow
            label="Cloakwire"
            control={
              <span className=" text-xs text-muted-foreground">v{APP_VERSION}</span>
            }
          />
          <SettingRow
            label={t("common.version")}
            hint={t("settings.coresHint")}
            control={
              <span className=" text-xs text-muted-foreground">
                {coreVersion ?? (inTauri ? "…" : "preview")}
              </span>
            }
          />
          <div className="px-4 py-3">
            <Button size="default" variant="outline"
              type="button"
              onClick={onOpenLogs}
              className="w-full"
            >
              <Terminal className="h-4 w-4 text-theme-accent" />
              {t("nav.logs")}
            </Button>
          </div>
          <div className="px-4 py-3">
            <Button size="default" variant="default"
              type="button"
              onClick={onRefreshAllSubs}
              disabled={subsFetching}
              className="w-full"
            >
              <RefreshCw
                className={cn("h-4 w-4 stroke-[2.5]", subsFetching && "animate-spin")}
              />
              {t("servers.updateAll")}
            </Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

/**
 * Device-wide HWID configuration. Most providers ignore this, but a
 * handful (anivka.top and similar) bind a subscription URL to the
 * first HWID they see and 403 every subsequent device. The fix is to
 * paste the "first" HWID from the device that already registered the
 * URL — typically a PC version of Cloakwire. The override is
 * **device-wide** so the user sets it once and every subscription on
 * the device uses it. 2026-08-20.
 */
function DeviceHwidSection() {
  const { t } = useI18n();
  const [info, setInfo] = useState<{
    effective: string;
    auto: string | null;
    custom: string | null;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    api
      .getDeviceHwid()
      .then(setInfo)
      .catch(() => setInfo(null));
  };

  useEffect(refresh, []);

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.setCustomHwid(trimmed);
      setInfo(next);
      setEditing(false);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setCustomHwid(null);
      setInfo(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resetAuto = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.resetDeviceHwid();
      setInfo(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!info?.effective) return;
    try {
      await navigator.clipboard.writeText(info.effective);
    } catch {
      /* ignore — UI still shows the value */
    }
  };

  return (
    <SectionCard>
      <SectionHeader title={t("servers.deviceHwidTitle")} />
      <div className="space-y-3 px-4 py-3 text-xs text-muted-foreground">
        <p>
          {t("servers.deviceHwidDesc")}
        </p>
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground/70">
            {t("servers.currentHwid")}
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-foreground">
              {info?.effective ?? (info === null ? "…" : "—")}
            </code>
            <Button size="sm" variant="outline"
              type="button"
              onClick={copy}
              disabled={!info?.effective}
            >
              {t("common.copy")}
            </Button>
          </div>
        </div>
        {info?.custom && (
          <p className="text-[11px]">
            <span className="font-mono text-foreground">{info.custom}</span>{" "}
            is a custom override (auto is{" "}
            <span className="font-mono text-foreground">{info.auto ?? "—"}</span>).
            <Button size="sm" variant="ghost"
              type="button"
              onClick={clear}
              disabled={busy}
            >
              {t("servers.clearOverride")}
            </Button>
          </p>
        )}
        {!editing ? (
          <Button size="sm" variant="outline"
            type="button"
            onClick={() => {
              setEditing(true);
              setDraft(info?.custom ?? "");
            }}
            disabled={busy}
          >
            {info?.custom ? t("servers.changeOverride") : t("servers.pasteFromOtherDevice")}
          </Button>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              placeholder="e.g. 11111111-2222-3333-4444-555555555555"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="atlas-input font-mono"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="default"
                type="button"
                onClick={save}
                disabled={busy || !draft.trim()}
              >
                {t("servers.saveOverride")}
              </Button>
              <Button size="sm" variant="outline"
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft("");
                  setError(null);
                }}
                disabled={busy}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
        <Button size="sm" variant="ghost"
          type="button"
          onClick={resetAuto}
          disabled={busy}
        >
          {t("servers.regenerateDeviceHwid")}
        </Button>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    </SectionCard>
  );
}
