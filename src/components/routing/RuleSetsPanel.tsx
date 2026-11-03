// RuleSetsPanel — manage the list of CustomRuleSet (external Loyalsoldier /
// meta-rules-dat / user-added URLs).
//
// Mostly CRUD with chips. Inline editor for tag + URL + format.

import { Plus, Trash2 } from "lucide-react";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { useI18n } from "@/lib/i18n";
import type { CustomRuleSet } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  ruleSets: CustomRuleSet[];
  onChange: (next: CustomRuleSet[]) => void;
}

export function RuleSetsPanel({ ruleSets, onChange }: Props) {
  const { t } = useI18n();
  const update = (tag: string, patch: Partial<CustomRuleSet>) => {
    onChange(ruleSets.map((rs) => (rs.tag === tag ? { ...rs, ...patch } : rs)));
  };
  const remove = (tag: string) => onChange(ruleSets.filter((rs) => rs.tag !== tag));
  const add = () => {
    const tag = prompt(t("routing.ruleSetTagPrompt"));
    if (!tag) return;
    if (!/^[a-z0-9_-]+$/.test(tag)) {
      alert(t("routing.ruleSetTagInvalid"));
      return;
    }
    if (ruleSets.some((rs) => rs.tag === tag)) {
      alert(t("routing.ruleSetExists", { tag }));
      return;
    }
    const url = prompt(t("routing.ruleSetUrlPrompt"));
    if (!url) return;
    onChange([
      ...ruleSets,
      {
        tag,
        type: "remote",
        format: url.endsWith(".json") ? "source" : "binary",
        url,
        update_interval: "1d",
        enabled: true,
      },
    ]);
  };

  return (
    <div className="rounded-xl border border-border/80 bg-[var(--atlas-field)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t("routing.ruleSetsTitle")}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("routing.ruleSetsDesc")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={add}>
          <Plus size={12} className="mr-1" />
          {t("common.add")}
        </Button>
      </div>

      {ruleSets.length === 0 && (
        <div className="rounded-lg border border-dashed border-border/80 bg-background/40 p-3 text-center text-xs text-muted-foreground font-mono">
          {t("routing.noRuleSets")}
        </div>
      )}

      <div className="space-y-2">
        {ruleSets.map((rs) => (
          <div
            key={rs.tag}
            className={cn(
              "rounded-lg border border-border/80 bg-[var(--atlas-field)] px-3.5 py-2.5",
              !rs.enabled && "opacity-60",
            )}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="checkbox"
                checked={rs.enabled}
                onChange={(e) => update(rs.tag, { enabled: e.target.checked })}
                title={`${t("common.enabled")} / ${t("common.disabled")}`}
                className="rounded border-input bg-background accent-brand focus:ring-brand"
              />
              <code className="text-xs text-theme-accent font-mono font-medium">{rs.tag}</code>
              <Badge variant="secondary" className="font-mono text-[10px]">{rs.type}</Badge>
              {rs.format && <Badge variant="outline" className="font-mono text-[10px]">{rs.format}</Badge>}
              {rs.update_interval && <Badge variant="outline" className="font-mono text-[10px]">↻ {rs.update_interval}</Badge>}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(rs.tag)}
                title={t("routing.removeRuleSet")}
                className="ml-auto"
              >
                <Trash2 size={12} />
              </Button>
            </div>
            {rs.type === "remote" && (
              <div className="mt-2">
                <input
                  type="text"
                  value={rs.url ?? ""}
                  onChange={(e) => update(rs.tag, { url: e.target.value })}
                  placeholder="https://…/geoip-cn.srs"
                  className="w-full rounded-md bg-[var(--atlas-field)] border border-border/80 px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-theme-accent focus:border-theme-accent font-mono"
                />
              </div>
            )}
            {rs.type === "local" && (
              <div className="mt-2">
                <input
                  type="text"
                  value={rs.path ?? ""}
                  onChange={(e) => update(rs.tag, { path: e.target.value })}
                  placeholder="C:\rules\my.srs"
                  className="w-full rounded-md bg-background border border-input px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
