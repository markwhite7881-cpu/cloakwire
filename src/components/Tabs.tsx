import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TabDef {
  /** Stable key (used for localStorage and React keys). */
  id: string;
  /** Short label shown in the tab bar. */
  label: string;
  /** Optional badge content (count, status dot, etc.). */
  badge?: ReactNode;
  /** Lucide icon component. */
  icon: React.ComponentType<{ className?: string }>;
  /** Tab body. */
  content: ReactNode;
}

export function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex items-center gap-1 bg-secondary/80 p-1 rounded-xl border border-border/80 shadow-inner"
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150",
              isActive
                ? "bg-background text-foreground shadow-sm font-semibold"
                : "text-muted-foreground hover:text-foreground hover:bg-background/40",
            )}
          >
            <Icon className={cn("h-3.5 w-3.5", isActive ? "text-emerald-500" : "text-muted-foreground")} />
            <span>{t.label}</span>
            {t.badge != null && (
              <span
                className={cn(
                  "ml-1 rounded-full px-1.5 py-0.2 text-[10px] tabular-nums font-mono",
                  isActive
                    ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/60"
                    : "bg-muted text-muted-foreground border border-border/60",
                )}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tabs.find((t) => t.id === active)?.content}
      </div>
    </div>
  );
}
