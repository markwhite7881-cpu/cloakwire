import { AtlasSwitch } from "@/components/atlas/AtlasSwitch";
import { AtlasHeading } from "@/components/atlas/AtlasHeading";
// RoutingTab — main container for the "Routing" page.
//
// The simple UX (top of the page, what 99% of users see):
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │  Apps via VPN                                               │
//   │  [Telegram ✕] [Chrome ✕]      [Pick from running… ▾]        │
//   │  → these processes route through VPN; everything else direct │
//   └─────────────────────────────────────────────────────────────┘
//   ┌─────────────────────────────────────────────────────────────┐
//   │  Apps direct                                                │
//   │  [Bank ✕]                 [Pick from running… ▾]            │
//   │  → force these processes to bypass VPN (e.g. bank apps)     │
//   └─────────────────────────────────────────────────────────────┘
//
//   <details>
//     <summary>Advanced</summary>
//     …full rule editor (matchers, drag-and-drop, presets,
//       rule-sets, sniff/final_outbound/JSON preview).
//   </details>
//
// The "Advanced" section is collapsed by default — non-tech-savvy
// users never see it. The simple UX is the answer to "just let me
// pick which programs use VPN and which don't, nothing else".

import { useMemo, useState } from "react";
import { Copy, Network, RotateCcw, Shield, ShieldOff, TriangleAlert, X } from "lucide-react";
import { Button } from "../Button";
import { RuleList } from "./RuleList";
import { PresetPicker } from "./PresetPicker";
import { RuleSetsPanel } from "./RuleSetsPanel";
import { ProcessPicker } from "./ProcessPicker";
import { newRuleId } from "@/lib/presets";
import { RoutingModePanel } from "./RoutingModePanel";
import { useI18n } from "@/lib/i18n";
import type { CustomRule, CustomRuleSet, GeneratorSettings, Outbound, RoutingOptions } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  profiles: Outbound[];
  engine?: "singbox" | "xray";
  settings: GeneratorSettings;
  onSettingsChange: (next: GeneratorSettings) => void;
}

export function RoutingTab({ profiles, settings, onSettingsChange, engine = "singbox" }: Props) {
  const { t } = useI18n();
  const r = settings.routing;
  const updateRouting = (patch: Partial<RoutingOptions>) =>
    onSettingsChange({ ...settings, routing: { ...r, ...patch } });

  // Routing only really works in TUN mode. In `system_proxy` the OS
  // sends browser traffic through the local proxy, but process-level
  // matchers (process_name / process_path) never fire because the
  // proxy doesn't see the originating process. `none` obviously has
  // no routing at all. So we lock the tab to read-only when the
  // configured tunnel mode is anything but TUN — and show a banner
  // pointing the user at the Config tab.
  const isTunActive =
    settings.tunnel_mode === "tun" || settings.tunnel_mode === "both";

  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);

  // Build a sing-box-style JSON view of the routing config.
  // This is purely informational — the *real* generation is in Rust.
  const jsonPreview = useMemo(() => buildJsonPreview(r), [r]);

  const appendRule = (rule: CustomRule) =>
    updateRouting({ rules: [...r.rules, rule] });

  const onAddRule = () => {
    const rule: CustomRule = {
      id: newRuleId(),
      label: "New rule",
      enabled: true,
      matchers: {},
      action: { kind: "route", outbound: "proxy" },
    };
    appendRule(rule);
  };

  const onAddRuleSet = (rs: CustomRuleSet) => {
    if (r.rule_sets.some((x) => x.tag === rs.tag)) {
      alert(`Rule-set "${rs.tag}" already exists`);
      return;
    }
    updateRouting({ rule_sets: [...r.rule_sets, rs] });
  };

  const onResetRouting = () => {
    if (r.rules.length > 0 || r.rule_sets.length > 0 || r.vpn_processes.length > 0 || r.direct_processes.length > 0) {
      if (!confirm(t("routing.resetConfirm"))) return;
    }
    updateRouting(DEFAULT_ROUTING);
  };

  const onCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(jsonPreview, null, 2));
      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 1500);
    } catch { /* ignore */ }
  };

  // Get all unique rule-set tags used in any rule's matchers (for warnings).
  const missingRuleSetTags = useMemo(() => {
    const used = new Set<string>();
    for (const rule of r.rules) {
      if (rule.enabled) {
        for (const tag of rule.matchers.rule_set ?? []) used.add(tag);
      }
    }
    const have = new Set(r.rule_sets.filter((x) => x.enabled).map((x) => x.tag));
    return Array.from(used).filter((t) => !have.has(t));
  }, [r.rules, r.rule_sets]);

  // Same process name in BOTH "Apps via VPN" and "Apps direct".
  // sing-box will route it direct (direct_processes rule comes first
  // in the generated `route.rules`), so the "VPN" entry is silently
  // overridden. Warn the user so the misconfiguration doesn't bite
  // them later.
  const overlapProcessNames = useMemo(() => {
    const v = new Set(r.vpn_processes.map((n) => n.toLowerCase()));
    const d = new Set(r.direct_processes.map((n) => n.toLowerCase()));
    const out: string[] = [];
    for (const n of v) {
      if (d.has(n)) {
        // Display the original case from the VPN list (whichever
        // order the user added them).
        const display = r.vpn_processes.find((x) => x.toLowerCase() === n) ?? n;
        out.push(display);
      }
    }
    return out;
  }, [r.vpn_processes, r.direct_processes]);

  return (
    <div className="atlas-page atlas-routing">
      <AtlasHeading title={t("routing.title")} icon={Network} description={t("routing.subtitle")} actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={onResetRouting}
            disabled={!isTunActive}
            title={isTunActive ? t("common.refresh") : t("routing.switchToTunToEdit")}
          >
            <RotateCcw size={14} className="mr-1" />
            {t("common.refresh")}
          </Button>
      }/>

      {/* TUN-required banner */}
      {!isTunActive && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2">
          <Network size={14} className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            {t("routing.tunRequiredBanner", { mode: settings.tunnel_mode })}
          </div>
        </div>
      )}

      <RoutingModePanel settings={settings} engine={engine} onChange={onSettingsChange} />

      {/* Overlap warning — same process in BOTH lists. */}
      {overlapProcessNames.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2">
          <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" />
          <div>
            {t("routing.sameProgramWarning", { programs: overlapProcessNames.join(", ") })}
          </div>
        </div>
      )}

      {/* Advanced — collapsed by default. */}
      <details className="atlas-disclosure">
        <summary className="cursor-pointer select-none px-2 py-1 text-sm font-semibold text-foreground hover:text-theme-accent flex items-center gap-2 list-none [&::-webkit-details-marker]:hidden">
          <span className="advanced-arrow text-xs text-muted-foreground" />
          {t("routing.advancedRulesTitle")}
          {(r.rules.length > 0 || r.rule_sets.length > 0) && (
            <span className="text-[10px] text-muted-foreground">
              {t("routing.rulesAndSetsCount", { rules: r.rules.length, ruleSets: r.rule_sets.length })}
            </span>
          )}
          {!isTunActive && (
            <span className="ml-auto text-[10px] text-amber-700 dark:text-amber-300 font-medium">
              {t("common.readOnly")}
            </span>
          )}
        </summary>
<div className="mt-4 space-y-4">
      {/* Advanced lists are preserved until an explicit edit. */}
      <ProcessPickerCard
        icon={<Shield size={18} className="text-theme-accent" />}
        title={t("routing.appsViaVpnTitle")}
        description={t("routing.appsViaVpnDesc")}
        accent="vpn"
        selected={r.vpn_processes}
        onChange={(next) => updateRouting({ vpn_processes: next })}
        disabled={!isTunActive || engine === "xray"}
      />
      <ProcessPickerCard
        icon={<ShieldOff size={18} className="text-theme-accent" />}
        title={t("routing.appsDirectTitle")}
        description={t("routing.appsDirectDesc")}
        accent="direct"
        selected={r.direct_processes}
        onChange={(next) => updateRouting({ direct_processes: next })}
        disabled={!isTunActive || engine === "xray"}
      />

</div>


        <div className="px-1 pb-1 pt-3 space-y-4 border-t border-border/80 mt-3">
          {/* General settings — sniff, final, auto_detect_interface */}
          <div
            className={cn(
              "atlas-editor-section",
              !isTunActive && "pointer-events-none opacity-60",
            )}
            aria-disabled={!isTunActive}
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                <AtlasSwitch label={t("routing.sniffProtocol")} checked={r.sniff} disabled={!isTunActive} onChange={enabled=>updateRouting({ sniff: enabled })} />
                {t("routing.sniffProtocol")}
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                <AtlasSwitch label={t("routing.autoDetectInterface")} checked={r.auto_detect_interface} disabled={!isTunActive} onChange={enabled=>updateRouting({ auto_detect_interface: enabled })} />
                {t("routing.autoDetectInterface")}
              </label>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t("routing.finalOutbound")}</label>
                <select
                  value={r.final_outbound}
                  onChange={(e) => updateRouting({ final_outbound: e.target.value })}
                  className="atlas-input w-full"
                >
                  <option value="direct">{t("routing.finalDirectSimple")}</option>
                  <option value="proxy">{t("routing.finalProxySelector")}</option>
                  <option value="auto">{t("routing.finalAutoUrltest")}</option>
                  <option value="block">{t("routing.finalBlock")}</option>
                  {profiles
                    .filter((o) => o.protocol !== "unsupported")
                    .filter((o, index, all) => !["direct", "proxy", "auto", "block"].includes(o.tag) && all.findIndex(p => p.tag === o.tag) === index)
                    .map((p) => (
                      <option key={p.tag} value={p.tag}>
                        {p.tag}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>

          {/* Warning: rules reference missing rule-sets */}
          {missingRuleSetTags.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
              ⚠ {t("routing.missingRuleSetsWarning", { tags: missingRuleSetTags.join(", ") })}
            </div>
          )}

          {/* Main: rule list — locked when not in TUN */}
          <div
            className={cn(!isTunActive && "pointer-events-none opacity-60")}
            aria-disabled={!isTunActive}
          >
            <h3 className="text-sm font-medium text-foreground mb-2">
              {t("routing.customRulesCount", { count: r.rules.length })}
            </h3>
            <RuleList
              rules={r.rules}
              outbounds={profiles.filter(
                (o): o is Exclude<typeof o, { protocol: "unsupported" }> =>
                  o.protocol !== "unsupported",
              )}
              onChange={(rules) => updateRouting({ rules })}
              onAdd={onAddRule}
            />
          </div>

          {/* Rule-sets — locked when not in TUN */}
          <div
            className={cn(!isTunActive && "pointer-events-none opacity-60")}
            aria-disabled={!isTunActive}
          >
            <RuleSetsPanel
              ruleSets={r.rule_sets}
              onChange={(rule_sets) => updateRouting({ rule_sets })}
            />
          </div>

          {/* Preset library — locked when not in TUN */}
          <div
            className={cn(!isTunActive && "pointer-events-none opacity-60")}
            aria-disabled={!isTunActive}
          >
            <PresetPicker onAddRule={appendRule} onAddRuleSet={onAddRuleSet} />
          </div>

          {/* JSON preview stays interactive */}
          <div className="flex items-center justify-end">
            <Button variant="ghost" size="sm" onClick={() => setJsonOpen(!jsonOpen)}>
              {jsonOpen ? t("routing.hideJson") : t("routing.showJson")}
            </Button>
          </div>
          {jsonOpen && (
            <div className="atlas-editor-section">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">
                  {t("routing.jsonTitle")}
                </span>
                <Button variant="ghost" size="sm" onClick={onCopyJson} title={t("common.copy")}>
                  <Copy size={12} className="mr-1" />
                  {jsonCopied ? t("common.copied") : t("common.copy")}
                </Button>
              </div>
              <pre className="text-xs text-theme-accent/90 overflow-x-auto whitespace-pre-wrap font-mono">
                {JSON.stringify(jsonPreview, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

// ---- Sub-components -----------------------------------------------

/** A "card" combining a header, a list of selected processes as
 *  removable chips, and a collapsible ProcessPicker below. This is
 *  the only thing a non-tech-savvy user ever sees on the Routing
 *  tab — both for "Apps via VPN" and "Apps direct". */
function ProcessPickerCard({
  icon,
  title,
  description,
  accent,
  selected,
  onChange,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  accent: "vpn" | "direct";
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <section
      className={cn(
        "atlas-process-group space-y-3",
        disabled && "opacity-70",
      )}
      aria-disabled={disabled}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5">{icon}</div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>

      {/* Selected chips. Empty state shows a tiny hint. */}
      {selected.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          {accent === "vpn"
            ? t("routing.noAppsPickedVpn")
            : t("routing.noAppsPickedDirect")}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                if (disabled) return;
                onChange(selected.filter((n) => n !== name));
              }}
              disabled={disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition",
                "hover:opacity-80",
                accent === "vpn"
                  ? "badge-theme font-medium"
                  : "border-border/80 bg-secondary/80 text-muted-foreground",
                disabled && "cursor-not-allowed hover:opacity-100",
              )}
              title={disabled ? t("routing.switchToTunToEdit") : t("routing.removeApp", { name })}
              aria-label={t("routing.removeApp", { name })}
            >
              <span className="font-mono">{name}</span>
              <X size={11} className="opacity-70" />
            </button>
          ))}
        </div>
      )}

      {/* The reusable ProcessPicker. The button "Pick from running…"
          stays inside it; the chip area above is the user's quick
          way to see and remove selections. */}
      <ProcessPicker selected={selected} onChange={onChange} disabled={disabled} />
    </section>
  );
}

// ---- Default used by "Reset" ---------------------------------------

const DEFAULT_ROUTING: RoutingOptions = {
  rules: [],
  rule_sets: [],
  vpn_processes: [],
  direct_processes: [],
  sniff: true,
  // "proxy" — matches the v1.0 behaviour and the canonical DEFAULT_SETTINGS
  // in src/lib/defaults.ts. Resetting routing means "give me the v1.0
  // baseline" (VPN for everything, except apps I add to Apps direct).
  final_outbound: "proxy",
  auto_detect_interface: true,
  default_domain_resolver: "local",
};

/** Build the sing-box `route` JSON view from a RoutingOptions. */
function buildJsonPreview(r: RoutingOptions) {
  const out: Record<string, unknown> = {};
  const rules: Record<string, unknown>[] = [];

  // Hard-coded DNS-bypass + optional sniff (mirrors Rust).
  rules.push({ network: "dns", action: "direct" });
  if (r.sniff) {
    rules.push({ action: "sniff" });
  }
  // Process-picker rules (the "simple" UX). Direct first, VPN second.
  if (r.direct_processes.length > 0) {
    rules.push({
      process_name: r.direct_processes,
      action: "route",
      outbound: "direct",
    });
  }
  if (r.vpn_processes.length > 0) {
    rules.push({
      process_name: r.vpn_processes,
      action: "route",
      outbound: "proxy",
    });
  }
  for (const rule of r.rules) {
    if (!rule.enabled) continue;
    const cleaned: Record<string, unknown> = {};
    // Strip empty arrays / falsy optionals so the preview is readable.
    for (const [k, v] of Object.entries(rule.matchers)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      cleaned[k] = v;
    }
    if (Object.keys(cleaned).length === 0) continue;
    if (rule.action.kind === "route") {
      rules.push({ ...cleaned, action: "route", outbound: rule.action.outbound });
    } else if (rule.action.kind === "reject") {
      rules.push({ ...cleaned, action: "reject" });
    } else if (rule.action.kind === "hijack-dns") {
      rules.push({ ...cleaned, action: "hijack-dns" });
    } else if (rule.action.kind === "sniff") {
      rules.push({ ...cleaned, action: "sniff" });
    } else if (rule.action.kind === "resolve") {
      rules.push({ ...cleaned, action: "resolve" });
    }
  }
  out.rules = rules;
  const ruleSets = r.rule_sets
    .filter((rs) => rs.enabled)
    .map((rs) => {
      const o: Record<string, unknown> = {
        tag: rs.tag,
        type: rs.type,
      };
      if (rs.format) o.format = rs.format;
      if (rs.type === "remote" && rs.url) o.url = rs.url;
      if (rs.type === "local" && rs.path) o.path = rs.path;
      if (rs.update_interval) o.update_interval = rs.update_interval;
      return o;
    });
  if (ruleSets.length > 0) out.rule_set = ruleSets;
  out.find_process = true;
  out.final = r.final_outbound;
  out.auto_detect_interface = r.auto_detect_interface;
  out.default_domain_resolver = r.default_domain_resolver;
  return out;
}
