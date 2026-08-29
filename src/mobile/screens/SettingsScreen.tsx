import { useEffect, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { api } from "@/lib/api";
import { vpnCoreVersion } from "@/lib/vpn";
import { cn } from "@/lib/utils";
import type { CustomRule, GeneratorSettings, RoutingOptions } from "@/lib/types";
import { newRuleId } from "@/lib/presets";
import { SectionCard, SectionHeader, SettingRow } from "../components/SectionCard";
import { Switch } from "../components/Switch";
import { type MobileEngine } from "@/mobile/lib/settings";

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

const HWID_INPUT_CLS =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring";

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

  const inputCls =
    "rounded-xl border border-white/10 bg-[#07080c] px-3 py-2 text-xs text-foreground focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/40";

  return (
    <div className="flex flex-col gap-4 p-4">
      <SectionCard>
        <SectionHeader title="General" />
        <div className="divide-y divide-white/5">
          <SettingRow
            label="Auto-connect"
            hint="Connect on app start."
            control={
              <Switch
                checked={autoConnect}
                onChange={onAutoConnectChange}
                label="Auto-connect"
              />
            }
          />
          <SettingRow
            label="Block IPv6"
            hint="Reject IPv6 traffic to prevent leaks."
            control={
              <Switch
                checked={ipv6Blocked}
                onChange={setIpv6Blocked}
                label="Block IPv6"
              />
            }
          />
          <SettingRow
            label="Remote rule-sets"
            hint={
              remoteSets.length === 0
                ? "No rule-sets configured."
                : `${remoteSets.length} rule-set${remoteSets.length === 1 ? "" : "s"} — download updates over the network.`
            }
            control={
              <Switch
                checked={remoteEnabled}
                onChange={setRemoteEnabled}
                disabled={remoteSets.length === 0}
                label="Remote rule-sets"
              />
            }
          />
        </div>
      </SectionCard>

      <SectionCard>
        <SectionHeader title="Network" />
        <div className="divide-y divide-white/5">
          <SettingRow
            label="DNS provider"
            control={
              <select
                value={dnsPreset}
                onChange={(e) => {
                  const p = DNS_PRESETS.find((x) => x.id === e.target.value);
                  if (p) update({ local_dns: p.local, remote_dns: p.remote });
                }}
                className={cn(inputCls, "max-w-[180px]")}
              >
                {DNS_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                {dnsPreset === "custom" && (
                  <option value="custom">Custom</option>
                )}
              </select>
            }
          />
          <SettingRow
            label="Mixed port"
            hint="Local SOCKS/HTTP listener."
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
                className={cn(inputCls, "w-24 text-right font-mono")}
              />
            }
          />
        </div>
      </SectionCard>

      {inTauri && <DeviceHwidSection />}

      <SectionCard>
        <SectionHeader title="About" />
        <div className="divide-y divide-white/5">
          <SettingRow
            label="Core versions"
            hint="Bundled sing-box and Xray cores."
            control={
              <span className="font-mono text-xs text-muted-foreground">
                {coreVersion ?? (inTauri ? "…" : "preview")}
              </span>
            }
          />
          <div className="px-4 py-3">
            <button
              type="button"
              onClick={onOpenLogs}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#07080c] text-sm text-foreground active:scale-[0.98] transition"
            >
              <Terminal className="h-4 w-4 text-emerald-400" />
              View logs
            </button>
          </div>
          <div className="px-4 py-3">
            <button
              type="button"
              onClick={onRefreshAllSubs}
              disabled={subsFetching}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 text-zinc-950 text-sm font-semibold shadow-md shadow-emerald-500/20 active:scale-[0.98] transition disabled:opacity-50"
            >
              <RefreshCw
                className={cn("h-4 w-4 stroke-[2.5]", subsFetching && "animate-spin")}
              />
              Check subscription updates
            </button>
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
      <SectionHeader title="Device HWID" />
      <div className="space-y-3 px-4 py-3 text-xs text-muted-foreground">
        <p>
          Device identifier sent to providers. If a subscription is bound
          to another device, paste its HWID here.
        </p>
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
            Current
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-foreground">
              {info?.effective ?? (info === null ? "…" : "—")}
            </code>
            <button
              type="button"
              onClick={copy}
              disabled={!info?.effective}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground active:bg-accent disabled:opacity-50"
            >
              Copy
            </button>
          </div>
        </div>
        {info?.custom && (
          <p className="text-[11px]">
            <span className="font-mono text-foreground">{info.custom}</span>{" "}
            is a custom override (auto is{" "}
            <span className="font-mono text-foreground">{info.auto ?? "—"}</span>).
            <button
              type="button"
              onClick={clear}
              disabled={busy}
              className="ml-2 underline decoration-dotted underline-offset-2 active:text-foreground disabled:opacity-50"
            >
              clear override
            </button>
          </p>
        )}
        {!editing ? (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setDraft(info?.custom ?? "");
            }}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-foreground active:bg-accent disabled:opacity-50"
          >
            {info?.custom ? "Change override" : "Paste HWID from another device"}
          </button>
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
              className={cn(HWID_INPUT_CLS, "font-mono text-xs")}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={save}
                disabled={busy || !draft.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground shadow-sm active:bg-primary/90 disabled:opacity-50"
              >
                Save override
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft("");
                  setError(null);
                }}
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-foreground active:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={resetAuto}
          disabled={busy}
          className="text-[11px] underline decoration-dotted underline-offset-2 active:text-foreground disabled:opacity-50"
        >
          Regenerate auto HWID (keeps any override)
        </button>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    </SectionCard>
  );
}
