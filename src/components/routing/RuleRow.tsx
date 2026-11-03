import { AtlasSwitch } from "@/components/atlas/AtlasSwitch";
// RuleRow — one rule in the sortable list.
//
// Compact (collapsed): drag handle, status pill, label, action summary,
// expand button, enable toggle, delete.
// Expanded: shows RuleEditor below.
//
// Used inside RuleList's <SortableContext>; receives drag attributes
// from `useSortable` (the parent wires that up via the `sortable` prop).

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronUp, GripVertical, Trash2 } from "lucide-react";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { RuleEditor } from "./RuleEditor";
import { useI18n } from "@/lib/i18n";
import type { CustomRule, Outbound } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  rule: CustomRule;
  outbounds: Outbound[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (next: CustomRule) => void;
  onDelete: () => void;
}

export function RuleRow({
  rule,
  outbounds,
  expanded,
  onToggleExpanded,
  onChange,
  onDelete,
}: Props) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rule.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Build a one-line "summary" of matchers + action for the collapsed view.
  const m = rule.matchers;
  const matcherSummary: string[] = [];
  if (m.domain?.length) matcherSummary.push(`domain × ${m.domain.length}`);
  if (m.domain_suffix?.length) matcherSummary.push(`suffix × ${m.domain_suffix.length}`);
  if (m.domain_keyword?.length) matcherSummary.push(`keyword × ${m.domain_keyword.length}`);
  if (m.ip_cidr?.length) matcherSummary.push(`ip_cidr × ${m.ip_cidr.length}`);
  if (m.port?.length) matcherSummary.push(`port × ${m.port.length}`);
  if (m.port_range?.length) matcherSummary.push(`port_range × ${m.port_range.length}`);
  if (m.network?.length) matcherSummary.push(`net: ${m.network.join("|")}`);
  if (m.protocol?.length) matcherSummary.push(`proto: ${m.protocol.join("|")}`);
  if (m.rule_set?.length) matcherSummary.push(`rs: ${m.rule_set.join(",")}`);
  if (m.process_name?.length) matcherSummary.push(`proc × ${m.process_name.length}`);
  if (m.ip_version === 6) matcherSummary.push("ipv6");
  if (m.ip_is_private) matcherSummary.push("private");
  if (rule.invert) matcherSummary.push("inverted");

  const actionSummary =
    rule.action.kind === "route"
      ? `→ ${rule.action.outbound}`
      : rule.action.kind === "reject"
      ? "✕ reject"
      : rule.action.kind === "hijack-dns"
      ? "→ DNS"
      : `(${rule.action.kind})`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "atlas-rule-row border transition overflow-hidden",
        rule.enabled ? "border-border/80" : "border-border/40 opacity-60",
        isDragging && "shadow-lg ring-1 ring-theme-accent",
      )}
    >
      {/* Collapsed bar */}
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="text-muted-foreground hover:text-foreground/80 cursor-grab active:cursor-grabbing"
          aria-label="Drag to reorder"
        >
          <GripVertical size={16} />
        </button>

        <AtlasSwitch label={(rule.label || t("routing.unnamedRule"))+" · "+t("common.enabled")} checked={rule.enabled}
          onChange={enabled=>onChange({...rule,enabled})} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground truncate">
              {rule.label || t("routing.unnamedRule")}
            </span>
            <Badge
              variant={
                rule.action.kind === "reject"
                  ? "destructive"
                  : rule.action.kind === "hijack-dns"
                  ? "secondary"
                  : "default"
              }
            >
              {actionSummary}
            </Badge>
          </div>
          {matcherSummary.length > 0 && (
            <div className="text-xs font-mono text-muted-foreground mt-0.5 truncate">
              {matcherSummary.join(" · ")}
            </div>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleExpanded}
          title={expanded ? t("common.close") : t("common.edit")}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          title={t("routing.deleteRule")}
        >
          <Trash2 size={14} />
        </Button>
      </div>

      {/* Inline editor (expanded) */}
      {expanded && (
        <div className="px-3.5 pb-3.5 pt-2 border-t border-border/60 bg-[var(--atlas-field)]">
          <RuleEditor
            rule={rule}
            outbounds={outbounds}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}
