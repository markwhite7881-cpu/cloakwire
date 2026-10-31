import { useRoutingModeDraft } from "@/hooks/useRoutingModeDraft";
import { describeRoutingMode } from "@/lib/routingMode";
import { Button } from "@/components/Button";
import { useEffect, useMemo, useState } from "react";
import { AppWindow, ChevronDown, Plus, Search, X } from "lucide-react";
import { vpnListApps, type AppEntry } from "@/lib/vpn";
import { newRuleId } from "@/lib/presets";
import { cn } from "@/lib/utils";
import { orderAppsForPicker, summarizeSelectedApps } from "../lib/mobileUi";
import type {
  CustomRule,
  GeneratorSettings,
  RoutingOptions,
} from "@/lib/types";
import { SectionCard, SectionHeader } from "../components/SectionCard";
import { Switch } from "../components/Switch";
import { useI18n } from "@/lib/i18n";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type TunAppMode = "all" | "include" | "exclude";

const APP_MODES = [
  { id: "all", labelKey: "routing.allApps" },
  { id: "include", labelKey: "routing.onlySelectedApps" },
  { id: "exclude", labelKey: "routing.allExceptSelectedApps" },
] as const;

/**
 * Global mode selector. The Settings model has no dedicated
 * `routing_mode` field — the closest existing knob is
 * `routing.final_outbound`: "proxy" = everything via the selector,
 * "auto" = urltest picks, "direct" = everything direct.
 */
const GLOBAL_MODES = [
  { id: "proxy", labelKey: "routing.globalModeTitle", hintKey: "routing.globalModeHint" },
  { id: "auto", labelKey: "routing.autoModeTitle", hintKey: "routing.autoModeHint" },
  { id: "direct", labelKey: "routing.directModeTitle", hintKey: "routing.directModeHint" },
] as const;

export function RoutingScreen({
  settings,
  onSettingsChange,
}: {
  settings: GeneratorSettings;
  onSettingsChange: (next: GeneratorSettings) => void;
}) {
  const { t } = useI18n();
  const r = settings.routing;
  const updateRouting = (patch: Partial<RoutingOptions>) =>
    onSettingsChange({ ...settings, routing: { ...r, ...patch } });

  const draft = useRoutingModeDraft(settings, "android", onSettingsChange);
  const summary = describeRoutingMode(settings, "android", "singbox");
  const mode = draft.mode;
  const appList = draft.list;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Mode */}
      <SectionCard>
        <SectionHeader
          title={t("home.mode")}
          description={t("routing.modeDesc")}
        />
        <div className="grid grid-cols-3 gap-2 p-3">
          {GLOBAL_MODES.map((m) => {
            const active = r.final_outbound === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => updateRouting({ final_outbound: m.id })}
                aria-pressed={active}
                title={t(m.hintKey)}
                className={cn(
                  "rounded-xl border py-2.5 px-2 text-xs font-medium transition-all duration-200",
                  active
                    ? "border-theme-accent bg-theme-subtle text-theme-accent font-semibold shadow-sm"
                    : "border-white/5 bg-[#07080c] text-muted-foreground active:scale-95 hover:text-foreground",
                )}
              >
                {t(m.labelKey)}
              </button>
            );
          })}
        </div>
      </SectionCard>

      <section className="rounded-xl border border-border p-3 text-sm space-y-2">
        <p className="font-semibold">{t("routingModes.title")}: {t("routingModes."+summary.mode)}</p>
        <p className="text-muted-foreground">{t("routingModes.android_scope")}</p>
        {summary.hasAdditionalRules&&<p className="text-muted-foreground">{t("routingModes.additional")}</p>}
      </section>
      {/* Per-app routing */}
      <PerAppSection
        mode={mode}
        appList={appList}
        hasRouteRules={r.rules.length > 0}
        onModeChange={draft.choose}
        onListChange={draft.changeList}
      />

      {draft.pending&&<section className="rounded-xl border border-border p-3 space-y-3">
        <p className="text-sm text-muted-foreground">{t("routingModes.pending")}</p>
        {!!draft.planned?.conflicts.length&&<p className="text-sm text-muted-foreground">{t("routingModes.conflict",{modes:draft.planned.conflicts.map(mode=>t("routingModes."+mode)).join(", ")})}</p>}
        {draft.error&&<p role="alert" className="text-sm text-destructive">{t(draft.error)}</p>}
        <div className="flex gap-2"><Button className="min-h-11" onClick={draft.apply}>{t("routingModes.apply")}</Button><Button className="min-h-11" variant="outline" onClick={draft.cancel}>{t("common.cancel")}</Button></div>
      </section>}
      {/* Rule groups */}
      <RuleGroup
        title={t("routing.proxyRoutingRules")}
        hint={t("routing.proxyRoutingRulesHint")}
        group="proxy"
        rules={r.rules}
        onChange={(rules) => updateRouting({ rules })}
      />
      <RuleGroup
        title={t("routing.directRoutingRules")}
        hint={t("routing.directRoutingRulesHint")}
        group="direct"
        rules={r.rules}
        onChange={(rules) => updateRouting({ rules })}
      />
      <RuleGroup
        title={t("routing.blockRoutingRules")}
        hint={t("routing.blockRoutingRulesHint")}
        group="block"
        rules={r.rules}
        onChange={(rules) => updateRouting({ rules })}
      />
    </div>
  );
}

// ---- Per-app VPN --------------------------------------------------

function AppIcon({ src }: { src?: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg"
      aria-hidden
    >
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <AppWindow className="h-6 w-6 text-muted-foreground" />
      )}
    </span>
  );
}

function PerAppSection({
  mode,
  appList,
  hasRouteRules,
  onModeChange,
  onListChange,
}: {
  mode: TunAppMode;
  appList: string[];
  hasRouteRules: boolean;
  onModeChange: (m: TunAppMode) => void;
  onListChange: (l: string[]) => void;
}) {
  const { t } = useI18n();
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded || apps != null || !inTauri) return;
    let cancelled = false;
    setLoading(true);
    vpnListApps()
      .then((list) => {
        if (cancelled) return;
        setLoading(false);
        setApps(list);
      })
      .catch((e) => {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, apps]);

  const selected = useMemo(() => new Set(appList), [appList]);
  const filtered = useMemo(() => {
    if (!apps) return [];
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.packageName.toLowerCase().includes(q),
    );
  }, [apps, query]);

  const visibleApps = useMemo(
    () => orderAppsForPicker(filtered, selected, mode),
    [filtered, mode, selected],
  );
  const pickerLabel = summarizeSelectedApps(apps, appList);

  const toggle = (pkg: string) => {
    const next = new Set(selected);
    if (next.has(pkg)) next.delete(pkg);
    else next.add(pkg);
    onListChange(Array.from(next));
  };

  return (
    <SectionCard>
      <SectionHeader title={t("routing.perAppRouting")} />
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-3 gap-2">
          {APP_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onModeChange(m.id)}
              aria-pressed={mode === m.id}
              className={cn(
                "min-h-11 rounded-xl border py-2.5 px-2 text-sm font-medium transition-all duration-200",
                mode === m.id
                  ? "border-theme-accent bg-theme-subtle text-theme-accent font-semibold shadow-sm"
                  : "border-white/5 bg-[#07080c] text-muted-foreground active:scale-95 hover:text-foreground",
              )}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>

        {!hasRouteRules && appList.length === 0 && (
          <div className="rounded-xl border border-white/5 bg-[#07080c] px-3.5 py-2.5 text-xs text-muted-foreground">
            {t("routing.addRouteOrSelectApps")}
          </div>
        )}

        {mode !== "all" && (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-[#07080c] px-3.5 py-2.5 text-xs text-foreground active:bg-secondary/60 transition"
            >
              <span className="font-medium">{pickerLabel}</span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </button>

            {expanded && (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#07080c] px-3">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("routing.searchApps")}
                    className="h-9 w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                  />
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                {loading && (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    {t("routing.loadingApps")}
                  </p>
                )}
                {!inTauri && (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    {t("routing.appOnlyOnAndroid")}
                  </p>
                )}
                {apps != null && visibleApps.length === 0 && !loading && (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    {t("routing.noAppsMatch")}
                  </p>
                )}
                {apps != null && (
                  <ul className="max-h-72 divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/5 bg-[#07080c]">
                    {visibleApps.map((a) => (
                      <li key={a.packageName}>
                        <button
                          type="button"
                          onClick={() => toggle(a.packageName)}
                          aria-pressed={selected.has(a.packageName)}
                          className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left active:bg-secondary/60 transition"
                        >
                          <span
                            className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
                              selected.has(a.packageName)
                                ? "border-theme-accent bg-theme-accent"
                                : "border-muted-foreground/40",
                            )}
                            aria-hidden
                          >
                            {selected.has(a.packageName) && (
                              <span className="h-2 w-2 rounded-sm bg-zinc-950" />
                            )}
                          </span>
                          <AppIcon src={a.icon} />
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                            {a.label}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}

// ---- Rule groups ----------------------------------------------------

type RuleGroupId = "proxy" | "direct" | "block";

function ruleGroup(rule: CustomRule): RuleGroupId | null {
  if (rule.action.kind === "reject") return "block";
  if (rule.action.kind === "route") {
    return rule.action.outbound === "direct" ? "direct" : "proxy";
  }
  return null; // sniff / resolve / hijack-dns — not shown in groups
}

function summarizeMatchers(rule: CustomRule): string {
  const m = rule.matchers;
  const parts: string[] = [];
  if (m.domain?.length) parts.push(...m.domain);
  if (m.domain_suffix?.length) parts.push(...m.domain_suffix.map((d) => `*.${d}`));
  if (m.domain_keyword?.length) parts.push(...m.domain_keyword.map((d) => `*${d}*`));
  if (m.ip_cidr?.length) parts.push(...m.ip_cidr);
  if (m.rule_set?.length) parts.push(...m.rule_set.map((t) => `[${t}]`));
  return parts.join(", ");
}

function buildRule(group: RuleGroupId, input: string): CustomRule {
  const trimmed = input.trim();
  const isCidr =
    /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(trimmed) ||
    trimmed.includes(":");
  const matchers = isCidr
    ? { ip_cidr: [trimmed] }
    : trimmed.startsWith("*.")
      ? { domain_suffix: [trimmed.slice(2)] }
      : trimmed.startsWith("[") && trimmed.endsWith("]")
        ? { rule_set: [trimmed.slice(1, -1)] }
        : { domain: [trimmed] };
  const action =
    group === "block"
      ? ({ kind: "reject" } as const)
      : ({ kind: "route", outbound: group === "direct" ? "direct" : "proxy" } as const);
  return {
    id: newRuleId(),
    label: trimmed,
    enabled: true,
    matchers,
    action,
  };
}

function RuleGroup({
  title,
  hint,
  group,
  rules,
  onChange,
}: {
  title: string;
  hint: string;
  group: RuleGroupId;
  rules: CustomRule[];
  onChange: (rules: CustomRule[]) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const mine = rules.filter((r) => ruleGroup(r) === group);

  const add = () => {
    const v = value.trim();
    if (!v) return;
    onChange([...rules, buildRule(group, v)]);
    setValue("");
  };

  return (
    <details className="group bento-card rounded-2xl border border-white/5 bg-[#0c0d14]/90 open:bg-[#0c0d14]/90 shadow-lg">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-4 py-3.5 text-sm font-semibold tracking-tight text-foreground [&::-webkit-details-marker]:hidden">
        <span className="advanced-arrow text-xs text-muted-foreground" />
        {title}
        <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
          {mine.length}
        </span>
      </summary>
      <div className="space-y-3 border-t border-white/5 px-4 pb-4 pt-3">
        <p className="text-[11px] text-muted-foreground">{hint}</p>
        {mine.length === 0 ? (
          <p className="py-1 text-[11px] italic text-muted-foreground/70">
            {t("routing.noEntries")}
          </p>
        ) : (
          <ul className="divide-y divide-white/5 rounded-xl border border-white/5 bg-[#07080c]">
            {mine.map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">
                    {rule.label || "rule"}
                  </p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {summarizeMatchers(rule)}
                  </p>
                </div>
                <Switch
                  checked={rule.enabled}
                  label={rule.label || "rule"}
                  onChange={(v) =>
                    onChange(
                      rules.map((r) =>
                        r.id === rule.id ? { ...r, enabled: v } : r,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
                  aria-label={t("common.delete")}
                  title={t("common.delete")}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive active:scale-95 transition"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder={group === "block" ? "ads.example.com" : "example.com or 1.2.3.0/24"}
            className="h-10 w-full rounded-xl border border-white/10 bg-[#07080c] px-3 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-theme-accent focus:outline-none focus:ring-1 focus:ring-theme-accent"
          />
          <button
            type="button"
            onClick={add}
            disabled={!value.trim()}
            aria-label={t("common.add")}
            title={t("common.add")}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-theme-accent text-zinc-950 shadow-theme-accent active:scale-95 transition hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4 stroke-[2.5]" />
          </button>
        </div>
      </div>
    </details>
  );
}
