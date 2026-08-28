// PresetPicker — quick insert for starter rules (Bypass LAN, Block Ads, etc).
//
// Two sections: "Starter rules" (RULE_PRESETS, become CustomRule in the
// rule list) and "Rule-sets" (RULE_SET_PRESETS, become CustomRuleSet in
// the rule-set list). Source toggle at the top filters which rule-sets
// are shown.

import { useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "../Badge";
import { Button } from "../Button";
import {
  RULE_PRESETS,
  RULE_SET_PRESETS,
  newRuleId,
  presetToRuleSet,
  type PresetSource,
  type RuleSetPreset,
} from "@/lib/presets";
import type { CustomRule, CustomRuleSet } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  onAddRule: (rule: CustomRule) => void;
  onAddRuleSet: (rs: CustomRuleSet) => void;
}

export function PresetPicker({ onAddRule, onAddRuleSet }: Props) {
  const [source, setSource] = useState<PresetSource | "all">("all");
  const filtered = RULE_SET_PRESETS.filter(
    (p) => source === "all" || p.source === source,
  );

  return (
    <div className="rounded-xl border border-border/80 bg-[#07080c] p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Starter rules</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          One-click inserts for common routing rules.
        </p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {RULE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onAddRule({ id: newRuleId(), ...p.build() })}
              className="text-left rounded-lg border border-border/80 bg-[#0b0c12] hover:border-emerald-500/50 hover:bg-emerald-950/20 transition px-3.5 py-2.5 group"
            >
              <div className="flex items-center gap-2">
                <Plus size={14} className="text-emerald-400 group-hover:scale-110 transition-transform" />
                <span className="text-sm font-medium text-foreground">{p.label}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 ml-5 line-clamp-2">
                {p.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border/80 pt-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Rule-set library</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pre-built rule-sets (Loyalsoldier / meta-rules-dat). Use the
              rule-set tag in any rule's <em>Rule-set</em> field.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border/80 bg-[#0b0c12] p-0.5 text-xs">
            {(["all", "loyalsoldier", "meta"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-mono transition",
                  source === s
                    ? "bg-emerald-500 text-zinc-950 font-medium shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {filtered.map((p) => (
            <RuleSetPresetRow
              key={p.tag}
              preset={p}
              onAdd={() => onAddRuleSet(presetToRuleSet(p))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RuleSetPresetRow({
  preset,
  onAdd,
}: {
  preset: RuleSetPreset;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded border border-border bg-background/40 px-2.5 py-1.5">
      <code className="text-xs text-foreground/80 font-mono">{preset.tag}</code>
      <span className="text-sm text-foreground truncate flex-1">{preset.label}</span>
      <Badge variant="secondary">{preset.source}</Badge>
      <Button variant="ghost" size="sm" onClick={onAdd} title="Add rule-set">
        <Plus size={12} />
      </Button>
    </div>
  );
}
