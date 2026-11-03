import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ChevronDown,
  CircleSlash,
  Loader2,
  Network,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { ProxiesResponse, StatusReport, ProxyInfo } from "@/lib/types";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEMO_PROXIES: ProxiesResponse = {
  proxies: {
    proxy: {
      type: "Selector",
      all: ["auto", "🇩🇪 DE-Reality-1", "🇳🇱 NL-Hy2-Edge", "🇸🇬 SG-AES", "🇺🇸 US-Trojan"],
      now: "auto",
      history: [],
    },
    auto: {
      type: "URLTest",
      all: ["🇩🇪 DE-Reality-1", "🇳🇱 NL-Hy2-Edge", "🇸🇬 SG-AES", "🇺🇸 US-Trojan"],
      now: "🇩🇪 DE-Reality-1",
      history: [
        { time: new Date(Date.now() - 60_000).toISOString(), delay: 132 },
        { time: new Date(Date.now() - 30_000).toISOString(), delay: 87 },
      ],
    },
    direct: { type: "Direct", all: [], now: null, history: [] },
    block: { type: "Block", all: [], now: null, history: [] },
    "🇩🇪 DE-Reality-1": { type: "VLESS", all: [], now: null, history: [] },
    "🇳🇱 NL-Hy2-Edge": { type: "Hysteria2", all: [], now: null, history: [] },
    "🇸🇬 SG-AES": { type: "Shadowsocks", all: [], now: null, history: [] },
    "🇺🇸 US-Trojan": { type: "Trojan", all: [], now: null, history: [] },
  },
};

function delayColor(d: number | null | undefined): string {
  if (d == null) return "text-muted-foreground";
  if (d < 100) return "text-success";
  if (d < 300) return "text-yellow-400";
  return "text-destructive";
}

export function proxiesCapability(
  status: StatusReport,
): "available" | "xray_unsupported" | "stopped" {
  if (status.status === "running" && status.engine === "xray") {
    return "xray_unsupported";
  }
  return status.status === "running" ? "available" : "stopped";
}

interface Props {
  status: StatusReport;
}

export function ProxiesCard({ status }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<ProxiesResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [latencies, setLatencies] = useState<Record<string, number | null>>({});
  // Collapsed by default — the proxy list can be 20+ rows and the
  // user only needs it open when actively diagnosing. Persisted in
  // localStorage so the choice survives a tab switch / restart.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("singbox.proxies.collapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "singbox.proxies.collapsed",
        collapsed ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  const capability = proxiesCapability(status);
  const isRunning = status.status === "running";
  const isXrayUnsupported = capability === "xray_unsupported";

  const refresh = useCallback(async () => {
    if (isXrayUnsupported) {
      setData(null);
      setError(null);
      setPending(false);
      setTesting(null);
      setLatencies({});
      return;
    }
    if (!inTauri) {
      setData(DEMO_PROXIES);
      return;
    }
    if (!isRunning) {
      setData(null);
      return;
    }
    try {
      const r = await api.listProxies();
      setData(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [isRunning, isXrayUnsupported]);

  useEffect(() => {
    refresh();
    if (capability !== "available") return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [capability, refresh]);

  const onSelect = async (group: string, member: string) => {
    if (!inTauri || capability !== "available") return;
    setPending(true);
    setError(null);
    try {
      await api.selectProxy(group, member);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const onTest = async (name: string) => {
    if (!inTauri || capability !== "available") return;
    setTesting(name);
    setError(null);
    try {
      const d = await api.testDelay(name, 3000);
      setLatencies((prev) => ({ ...prev, [name]: d ?? null }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(null);
    }
  };

  const proxies = data?.proxies ?? {};
  const groups = Object.entries(proxies).filter(
    ([, p]) => p.type === "Selector" || p.type === "URLTest",
  );

  return (
    <div className="atlas-section">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="atlas-section-head flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
              <Network className="h-4 w-4 text-theme-accent" />
              {t("proxies.title")}
              <Badge variant="secondary" >
                {groups.length}
              </Badge>
            </h3>
            {capability === "available" ? (
              <Badge variant="default" >
                {t("proxies.liveBadge")}
              </Badge>
            ) : capability === "xray_unsupported" ? (
              <Badge variant="outline" >
                {t("proxies.unavailableBadge")}
              </Badge>
            ) : (
              <Badge variant="outline" >
                {t("proxies.notRunningBadge")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {isXrayUnsupported
              ? t("proxies.singboxOnlyHint")
              : t("proxies.clashApiHint")}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            !collapsed && "rotate-180",
          )}
        />
      </button>
      {!collapsed && (
        <div className="atlas-section-body space-y-2">
          {isXrayUnsupported ? (
            <p className="rounded border border-border bg-card/40 p-3 text-[11px] text-muted-foreground">
              {t("proxies.xraySwitchNotice")}
            </p>
          ) : (
            <>
              {error && (
                <p className="text-[11px] text-destructive">{error}</p>
              )}
              {!isRunning && (
                <p className="rounded border border-border bg-card/40 p-3 text-[11px] text-muted-foreground">
                  {t("proxies.startNotice")}
                </p>
              )}
              {isRunning && groups.length === 0 && (
                <p className="rounded border border-border bg-card/40 p-3 text-[11px] text-muted-foreground">
                  {t("proxies.noGroupsFound")}
                </p>
              )}
              <div className="space-y-2">
                {groups.map(([name, info]) => (
                  <ProxyGroup
                    key={name}
                    name={name}
                    info={info}
                    onSelect={(member) => onSelect(name, member)}
                    onTest={onTest}
                    testing={testing}
                    pending={pending}
                    disabled={!inTauri}
                    extraLatency={latencies}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ProxyGroup({
  name,
  info,
  onSelect,
  onTest,
  testing,
  pending,
  disabled,
  extraLatency,
}: {
  name: string;
  info: ProxyInfo;
  onSelect: (member: string) => void;
  onTest: (name: string) => void;
  testing: string | null;
  pending: boolean;
  disabled: boolean;
  extraLatency: Record<string, number | null>;
}) {
  const { t } = useI18n();
  const isSelector = info.type === "Selector";
  const isUrlTest = info.type === "URLTest";

  // Use the latest history sample as the displayed delay; if the
  // group itself has no history (Selector) and the user clicked
  // "Test all", we fall back to the per-member extraLatency.
  const groupDelay =
    info.history.length > 0
      ? info.history[info.history.length - 1].delay
      : null;

  return (
    <div className="rounded-md border border-border bg-card/40">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="default" >
            {info.type}
          </Badge>
          <span className="truncate text-sm font-medium" title={name}>
            {name}
          </span>
          {info.now && (
            <span className="rounded bg-muted px-1.5 py-0 font-mono text-[10px] text-muted-foreground">
              → {info.now}
            </span>
          )}
          {(isUrlTest || groupDelay != null) && (
            <span
              className={cn(
                "ml-auto font-mono text-[11px] tabular-nums",
                delayColor(groupDelay),
              )}
            >
              {groupDelay == null ? "—" : `${groupDelay} ms`}
            </span>
          )}
        </div>
        {!disabled && isUrlTest && (
          <Button
            variant="ghost"
            size="icon"

            onClick={() => onTest(name)}
            disabled={testing === name}
            title={t("proxies.testLatency")}
          >
            {testing === name ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
      </div>
      <div className="space-y-1 p-2">
        {info.all.map((member) => {
          const active = info.now === member;
          const memberDelay =
            extraLatency[member] ??
            // find the last matching history entry
            null;
          return (
            <button aria-pressed={active}
              key={member}
              onClick={() => isSelector && !disabled && onSelect(member)}
              disabled={disabled || !isSelector || pending}
              className="atlas-pick-row"
              title={isSelector ? t("proxies.switchProxyTitle", { group: name, member }) : member}
            >
              {active ? (
                <Activity className="h-3.5 w-3.5 text-foreground" />
              ) : (
                <CircleSlash className="h-3.5 w-3.5 text-muted-foreground/50" />
              )}
              <span className="truncate font-mono text-[11px]">{member}</span>
              {isSelector && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {t("proxies.select")}
                </span>
              )}
              {!isSelector && memberDelay != null && (
                <span
                  className={cn(
                    "ml-auto font-mono text-[10px] tabular-nums",
                    delayColor(memberDelay),
                  )}
                >
                  {memberDelay} ms
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
