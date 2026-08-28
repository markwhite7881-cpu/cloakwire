import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Obsidian Bento bordered card used as the section container on mobile. */
export function SectionCard({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "bento-card rounded-2xl p-0 overflow-hidden text-card-foreground shadow-lg",
        className,
      )}
      {...props}
    />
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/** One settings row: label (+optional hint) left, control right. */
export function SettingRow({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {control}
    </div>
  );
}
