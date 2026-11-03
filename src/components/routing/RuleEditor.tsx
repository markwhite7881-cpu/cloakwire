import { AtlasSwitch } from "@/components/atlas/AtlasSwitch";
// RuleEditor — inline editor for one CustomRule.
//
// When a `RuleRow` is expanded, this component renders BELOW the row
// with a flat list of matcher chips + an action selector. Saving is
// implicit — every keystroke calls `onChange`.
//
// Design goals:
//   - 95% of users only need: domain / domain_suffix / ip_cidr / port /
//     rule_set / action=route|reject. Those are always visible.
//   - Advanced matchers (process_*, regex, source_*, auth_user, ...) are
//     hidden under a collapsible "Advanced" disclosure.
//   - No nested forms. One field type per line. Add/remove via inline buttons.

import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Button } from "../Button";
import { ProcessPicker } from "./ProcessPicker";
import { useI18n } from "@/lib/i18n";
import type { CustomRule, Outbound, RuleAction, RuleMatchers } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  rule: CustomRule;
  /** All available outbound tags (for the action dropdown). */
  outbounds: Outbound[];
  onChange: (next: CustomRule) => void;
}

type ArrayField = keyof Pick<
  RuleMatchers,
  | "domain"
  | "domain_suffix"
  | "domain_keyword"
  | "domain_regex"
  | "ip_cidr"
  | "source_ip_cidr"
  | "port"
  | "port_range"
  | "source_port"
  | "source_port_range"
  | "process_name"
  | "process_path"
  | "protocol"
  | "rule_set"
  | "inbound"
>;

// Pre-defined chips for fields where the set of values is fixed.
const NETWORK_OPTIONS = ["tcp", "udp", "icmp"] as const;
const PROTOCOL_OPTIONS = ["http", "tls", "quic", "dns", "stun", "ntp", "ssh", "rdp", "mongodb", "postgresql"] as const;
const ACTION_KINDS: Array<RuleAction["kind"]> = ["route", "reject", "hijack-dns", "sniff", "resolve"];

export function RuleEditor({ rule, outbounds, onChange }: Props) {
  const { t } = useI18n();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const m = rule.matchers;
  const a = rule.action;

  const setAction = (next: RuleAction) => onChange({ ...rule, action: next });
  const setLabel = (label: string) => onChange({ ...rule, label });

  /** Update a string[] matcher (add / edit / remove). */
  const updateArray = (field: ArrayField, values: string[] | number[] | undefined) => {
    const next: RuleMatchers = { ...m };
    if (values === undefined || (Array.isArray(values) && values.length === 0)) {
      delete (next as Record<string, unknown>)[field as string];
    } else {
      (next as Record<string, unknown>)[field as string] = values;
    }
    onChange({ ...rule, matchers: next });
  };

  const toggleInArray = (field: ArrayField, value: string) => {
    const cur = (m[field] as string[] | undefined) ?? [];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    updateArray(field, next);
  };

  const toggleInPortArray = (field: "port" | "source_port", value: number) => {
    const cur = (m[field] as number[] | undefined) ?? [];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    updateArray(field, next);
  };

  return (
    <div className="rounded-md border border-border bg-card/30 p-4 space-y-4">
      {/* Label */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          {t("routing.label")}
        </label>
        <input
          type="text"
          value={rule.label ?? ""}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("routing.labelPlaceholder")}
          className="atlas-input w-full"
        />
      </div>

      {/* Action */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          {t("routing.action")}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {ACTION_KINDS.map((kind) => (
            <button aria-pressed={a.kind === kind}
              key={kind}
              type="button"
              onClick={() => {
                if (kind === "route") setAction({ kind, outbound: "proxy" });
                else if (kind === "reject") setAction({ kind });
                else if (kind === "hijack-dns") setAction({ kind });
                else if (kind === "sniff") setAction({ kind });
                else if (kind === "resolve") setAction({ kind });
              }}
              className="atlas-choice"
            >
              {kind}
            </button>
          ))}
        </div>
        {a.kind === "route" && (
          <div className="mt-2">
            <select
              value={a.outbound}
              onChange={(e) => setAction({ kind: "route", outbound: e.target.value })}
              className="atlas-input w-full font-mono"
            >
              <option value="proxy">{t("routing.finalProxySelector")}</option>
              <option value="auto">{t("routing.finalAutoUrltest")}</option>
              <option value="direct">{t("common.direct")}</option>
              <option value="block">{t("common.block")}</option>
              {outbounds
                .filter((o) => o.protocol !== "unsupported")
                .map((o) => (
                  <option key={o.tag} value={o.tag}>
                    {o.tag} ({o.protocol})
                  </option>
                ))}
            </select>
          </div>
        )}
      </div>

      {/* Matchers — main (always visible) */}
      <div className="space-y-3">
        <ChipField
          label={t("routing.domainExact")}
          field="domain"
          values={m.domain}
          placeholder="example.com"
          onChange={(v) => updateArray("domain", v)}
        />
        <ChipField
          label={t("routing.domainSuffix")}
          field="domain_suffix"
          values={m.domain_suffix}
          placeholder=".example.com"
          onChange={(v) => updateArray("domain_suffix", v)}
        />
        <ChipField
          label={t("routing.domainKeyword")}
          field="domain_keyword"
          placeholder="substring"
          values={m.domain_keyword}
          onChange={(v) => updateArray("domain_keyword", v)}
        />
        <ChipField
          label={t("routing.ipCidr")}
          field="ip_cidr"
          values={m.ip_cidr}
          placeholder="10.0.0.0/8"
          onChange={(v) => updateArray("ip_cidr", v)}
        />
        <PortField
          label={t("routing.portRule")}
          field="port"
          values={m.port}
          onChange={(v) => updateArray("port", v)}
        />
        <ChipField
          label={t("routing.portRange")}
          field="port_range"
          values={m.port_range}
          placeholder="1000:2000"
          onChange={(v) => updateArray("port_range", v)}
        />
        <ChipsPicker
          label={t("routing.network")}
          options={NETWORK_OPTIONS}
          values={(m.network as string[] | undefined) ?? []}
          onToggle={(v) => toggleInArray("network" as ArrayField, v)}
        />
        <ChipsPicker
          label={t("routing.protocolSniffed")}
          options={PROTOCOL_OPTIONS}
          values={(m.protocol as string[] | undefined) ?? []}
          onToggle={(v) => toggleInArray("protocol" as ArrayField, v)}
        />
        <ChipField
          label={t("routing.ruleSetTag")}
          field="rule_set"
          values={m.rule_set}
          placeholder="geoip-cn"
          onChange={(v) => updateArray("rule_set", v)}
        />
        <div className="flex items-center gap-2">
          <AtlasSwitch
              id={`invert-${rule.id}`} label={t("routing.invert")} checked={rule.invert === true}
              onChange={enabled => onChange({ ...rule, invert: enabled || undefined })}
            />
          <label htmlFor={`invert-${rule.id}`} className="text-sm text-foreground/80 select-none">
            {t("routing.invert")}
          </label>
        </div>
      </div>

      {/* Advanced — collapsed by default */}
      <div className="border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {t("routing.advancedMatchers")}
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-3">
            <ChipField
              label={t("routing.domainRegex")}
              field="domain_regex"
              values={m.domain_regex}
              placeholder="^stun\\..+"
              onChange={(v) => updateArray("domain_regex", v)}
            />
            <ChipField
              label={t("routing.sourceIpCidr")}
              field="source_ip_cidr"
              values={m.source_ip_cidr}
              placeholder="192.168.0.0/16"
              onChange={(v) => updateArray("source_ip_cidr", v)}
            />
            <PortField
              label={t("routing.sourcePort")}
              field="source_port"
              values={m.source_port}
              onChange={(v) => updateArray("source_port", v)}
            />
            <ChipField
              label={t("routing.processNameWinMac")}
              field="process_name"
              values={m.process_name}
              placeholder="chrome"
              onChange={(v) => updateArray("process_name", v)}
            />
            <ProcessPicker
              selected={m.process_name ?? []}
              onChange={(v) => updateArray("process_name", v)}
            />
            <ChipField
              label={t("routing.processPath")}
              field="process_path"
              values={m.process_path}
              placeholder="/usr/bin/curl"
              onChange={(v) => updateArray("process_path", v)}
            />
            <ChipField
              label={t("routing.inboundTag")}
              field="inbound"
              values={m.inbound}
              placeholder="tun-in"
              onChange={(v) => updateArray("inbound", v)}
            />
            <div className="flex items-center gap-2">
              <AtlasSwitch
                id={`private-${rule.id}`}
                label={t("routing.matchPrivateIps")}
                checked={m.ip_is_private === true}
                onChange={enabled => onChange({
                  ...rule,
                  matchers: enabled ? { ...m, ip_is_private: true } : omitKey(m, "ip_is_private"),
                })}
              />
              <label htmlFor={`private-${rule.id}`} className="text-sm text-foreground/80 select-none">
                {t("routing.matchPrivateIps")}
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Small sub-components ────────────────────────────────────────────────

interface ChipFieldProps {
  label: string;
  field: string;
  values: string[] | undefined;
  placeholder?: string;
  onChange: (next: string[] | undefined) => void;
}

function ChipField({ label, values, placeholder, onChange }: ChipFieldProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const arr = values ?? [];

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (arr.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...arr, v]);
    setDraft("");
  };
  const remove = (v: string) => onChange(arr.filter((x) => x !== v));

  return (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">{label}</label>
      <div className="flex flex-wrap gap-1.5 items-center">
        {arr.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-lg bg-theme-subtle text-theme-accent border border-theme-accent-subtle px-2.5 py-0.5 text-xs font-mono"
          >
            {v}
            <button
              type="button"
              onClick={() => remove(v)}
              className="text-theme-accent/70 hover:text-theme-accent ml-0.5"
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              } else if (e.key === "Backspace" && draft === "" && arr.length > 0) {
                remove(arr[arr.length - 1]);
              }
            }}
            placeholder={placeholder}
            className="atlas-input font-mono"
          />
          <Button variant="ghost" size="sm" onClick={add} title={t("common.add")}>
            <Plus size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface PortFieldProps {
  label: string;
  field: string;
  values: number[] | undefined;
  onChange: (next: number[] | undefined) => void;
}

function PortField({ label, values, onChange }: PortFieldProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const arr = values ?? [];
  const add = () => {
    const n = parseInt(draft.trim(), 10);
    if (Number.isNaN(n) || n < 1 || n > 65535) return;
    if (arr.includes(n)) { setDraft(""); return; }
    onChange([...arr, n]);
    setDraft("");
  };
  const remove = (n: number) => onChange(arr.filter((x) => x !== n));
  return (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">{label}</label>
      <div className="flex flex-wrap gap-1.5 items-center">
        {arr.map((n) => (
          <span
            key={n}
            className="inline-flex items-center gap-1 rounded-lg bg-theme-subtle text-theme-accent border border-theme-accent-subtle px-2.5 py-0.5 text-xs font-mono"
          >
            {n}
            <button
              type="button"
              onClick={() => remove(n)}
              className="text-theme-accent/70 hover:text-theme-accent ml-0.5"
              aria-label={`Remove port ${n}`}
            >
              ×
            </button>
          </span>
        ))}
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={65535}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); add(); }
            }}
            placeholder="443"
            className="atlas-input w-24 font-mono"
          />
          <Button variant="ghost" size="sm" onClick={add} title={t("common.add")}>
            <Plus size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ChipsPickerProps {
  label: string;
  options: readonly string[];
  values: string[];
  onToggle: (value: string) => void;
}

function ChipsPicker({ label, options, values, onToggle }: ChipsPickerProps) {
  return (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = values.includes(opt);
          return (
            <button aria-pressed={active}
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              className="atlas-choice"
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function omitKey<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> {
  const copy = { ...o };
  delete copy[k];
  return copy;
}
