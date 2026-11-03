import { type ReactNode } from "react";

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
    <div role="tablist" className="atlas-nav">
      {tabs.map((t) => {
        const Icon = t.icon;
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className="atlas-nav-item"
          >
            <Icon className="atlas-nav-icon" />
            <span className="atlas-nav-label">{t.label}</span>
            {t.badge != null && <span className="atlas-count">{t.badge}</span>}
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
