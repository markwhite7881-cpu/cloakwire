import { Activity, AlertCircle, Loader2, Power, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Status } from "@/lib/types";

const CONFIG: Record<
  Status,
  { label: string; dot: string; icon: React.ReactNode }
> = {
  stopped: {
    label: "Stopped",
    dot: "bg-muted-foreground",
    icon: <Power className="h-3.5 w-3.5" />,
  },
  starting: {
    label: "Starting",
    dot: "bg-foreground",
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  },
  running: {
    label: "Connected",
    dot: "bg-theme-accent",
    icon: <Activity className="h-3.5 w-3.5 text-theme-accent" />,
  },
  crashed: {
    label: "Crashed",
    dot: "bg-destructive",
    icon: <AlertCircle className="h-3.5 w-3.5" />,
  },
  stopping: {
    label: "Stopping",
    dot: "bg-muted-foreground",
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  },
};

import { useI18n } from "@/lib/i18n";

export function StatusPill({
  status,
  onClick,
  disabled,
}: {
  status: Status;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const cfg = CONFIG[status] ?? CONFIG.stopped;
  const className = "atlas-session-control";

  const localizedLabel = (() => {
    switch (status) {
      case "running":
        return t("common.connected");
      case "stopped":
        return t("common.disconnected");
      case "starting":
        return t("common.connecting");
      case "stopping":
        return t("common.stopping");
      case "crashed":
        return t("common.error");
      default:
        return cfg.label;
    }
  })();

  const inner = (
    <>
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          cfg.dot,
        )}
      />
      <span className="text-sm font-medium">{localizedLabel}</span>
      {cfg.icon}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={className}
        title={
          status === "running" || status === "starting"
            ? "Click to disconnect"
            : "Click to connect"
        }
      >
        {inner}
      </button>
    );
  }
  return <div className={className}>{inner}</div>;
}

export function StatusIconLarge({ status }: { status: Status }) {
  if (status === "running") {
    return (
      <div className="relative">
        <div className="absolute inset-0 animate-pulse-dot rounded-full bg-foreground/10 blur-xl" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-foreground/5 ring-1 ring-foreground/15">
          <Activity className="h-9 w-9 text-foreground" />
        </div>
      </div>
    );
  }
  if (status === "starting" || status === "stopping") {
    return (
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted ring-1 ring-border">
        <Loader2 className="h-9 w-9 animate-spin text-foreground" />
      </div>
    );
  }
  if (status === "crashed") {
    return (
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/30">
        <AlertCircle className="h-9 w-9 text-destructive" />
      </div>
    );
  }
  return (
    <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted ring-1 ring-border">
      <ShieldOff className="h-9 w-9 text-muted-foreground" />
    </div>
  );
}
