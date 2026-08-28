import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Gauge, Link2, Loader2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { FlagIcon } from "@/components/FlagIcon";
import { api } from "@/lib/api";
import { flagForProfile } from "@/lib/flags";
import { isSupported, profileEndpoint, profileLabel } from "@/lib/outbound";
import { useServerLatency } from "@/hooks/useServerLatency";
import { vpnTestLatency } from "@/lib/vpn";
import { cn } from "@/lib/utils";
import type { Outbound, Subscription } from "@/lib/types";
import type { FetchResult } from "@/hooks/useSubscriptions";
import type { ServerGroup } from "../lib/serverGrouping";
import { AddSubscriptionSheet } from "../components/AddSubscriptionSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { SectionCard, SectionHeader } from "../components/SectionCard";
import { formatMs } from "../lib/format";
import { latencyTone } from "../lib/mobileUi";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const PROBE_TIMEOUT_MS = 2_000;

export function ServersScreen({
  profiles,
  groups,
  selectedIndex,
  geoipByIp,
  onSelect,
  subs,
  subFetching,
  lastResult,
  engine,
  onAddSub,
  onAddLinks,
  onRemoveSub,
  onRefreshSub,
  activeBundle,
  onSelectBundleChild,
  onRemoveManual,
}: {
  profiles: Outbound[];
  groups: ServerGroup[];
  selectedIndex: number;
  geoipByIp: Record<string, string>;
  onSelect: (index: number) => void;
  subs: Subscription[];
  subFetching: Record<string, boolean>;
  /** Per-subscription outbounds cache. Used to render the live
   *  server count for each subscription row in the overview list —
   *  the `Subscription` shape no longer stores a count (it is
   *  derived from this map at render time). 2026-08-21. */
  lastResult: Record<string, FetchResult>;
  /** Active engine name; used for the header badge. */
  engine: "sing-box" | "xray" | "";
  onAddSub: (input: { name?: string; url: string }) => Promise<void>;
  onAddLinks: (outbounds: Outbound[]) => void;
  onRemoveSub: (id: string) => void;
  onRefreshSub: (id: string) => void;
  /** Currently selected bundle child (or null). The Servers screen
   *  shows a "selected" indicator on the matching row inside any
   *  bundle subscription. 2026-08-20. */
  activeBundle: {
    subscriptionId: string;
    childKey: string;
    engine: "singbox" | "xray";
    childName: string;
  } | null;
  /** Pin a bundle child as the active target. The actual VPN
   *  connect is deferred to the Home screen — the Servers screen
   *  only updates selection state. */
  onSelectBundleChild: (input: {
    subscriptionId: string;
    childKey: string;
    engine: "singbox" | "xray";
    childName: string;
  }) => void | Promise<void>;
  /** Delete a manual profile by tag. */
  onRemoveManual: (tag: string) => void;
}) {
  // Auto-probe every 10 s (reused desktop hook); "Ping all" fires an
  // extra manual pass and overlays its results on the hook's map.
  const auto = useServerLatency(profiles);
  const [manual, setManual] = useState<Map<string, number>>(new Map());
  const [pinging, setPinging] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Bundle children carry a dial endpoint (Rust extracts it from the
  // provider config) — probe those with the same TCP ping the
  // link-list rows use, on the same cadence.
  const childEndpoints = useMemo(
    () =>
      subs
        .filter((s) => s.kind === "xray_bundle" || s.kind === "singbox_bundle")
        .flatMap((s) =>
          s.children
            .filter((c) => c.endpoint)
            .map((c) => ({
              key: `${s.id}:${c.key}`,
              host: c.endpoint!.host,
              port: c.endpoint!.port,
            })),
        ),
    [subs],
  );
  const [childLatency, setChildLatency] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (childEndpoints.length === 0 || !inTauri) return;
    let cancelled = false;
    const probe = async () => {
      const results = await Promise.allSettled(
        childEndpoints.map((c) =>
          api.pingEndpoint(c.host, c.port, PROBE_TIMEOUT_MS),
        ),
      );
      if (cancelled) return;
      const next = new Map<string, number>();
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value != null) {
          next.set(childEndpoints[i].key, r.value);
        }
      });
      setChildLatency(next);
    };
    void probe();
    const timer = window.setInterval(() => void probe(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [childEndpoints]);

  // Collapsible subscription blocks (same UX as Home). Subscription
  // blocks with zero servers are not rendered at all, and they start
  // COLLAPSED until the user expands one (the touched set remembers
  // which blocks the user has interacted with).
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());
  const touchedBlocks = useRef<Set<string>>(new Set());
  const isBlockCollapsed = (id: string) =>
    touchedBlocks.current.has(id) ? collapsedBlocks.has(id) : true;
  const toggleBlock = (id: string) => {
    touchedBlocks.current.add(id);
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Deletions go through a confirmation popup.
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "manual" | "subscription";
    key: string;
    label: string;
  } | null>(null);

  const latencyByTag = useMemo(() => {
    const merged = new Map(auto.byTag);
    for (const [k, v] of manual) merged.set(k, v);
    return merged;
  }, [auto.byTag, manual]);

  const pingAll = async () => {
    const supported = profiles.filter(isSupported);
    if (supported.length === 0 || pinging) return;
    setPinging(true);
    try {
      // Real end-to-end test: one short-lived tester xray, one socks
      // inbound per profile, generate_204 through each. Falls back to
      // TCP-ping when the tester is unavailable (e.g. browser preview).
      let next = new Map<string, number>();
      try {
        const spec = await api.generateXrayTestConfig(supported);
        const results = await vpnTestLatency(spec.config, spec.entries);
        for (const r of results) {
          if (r.ms != null) next.set(r.tag, r.ms);
        }
      } catch {
        const probes = await Promise.allSettled(
          supported.map((p) =>
            api
              .pingEndpoint(p.server, p.port, PROBE_TIMEOUT_MS)
              .then((d) => ({ tag: p.tag, ms: d }))
              .catch(() => ({ tag: p.tag, ms: null as number | null })),
          ),
        );
        for (const r of probes) {
          if (r.status === "fulfilled" && r.value.ms != null) {
            next.set(r.value.tag, r.value.ms);
          }
        }
      }
      // Bundle children share the same manual pass via their dial
      // endpoints.
      if (childEndpoints.length > 0) {
        const childResults = await Promise.allSettled(
          childEndpoints.map((c) =>
            api.pingEndpoint(c.host, c.port, PROBE_TIMEOUT_MS),
          ),
        );
        const childNext = new Map<string, number>();
        childResults.forEach((r, i) => {
          if (r.status === "fulfilled" && r.value != null) {
            childNext.set(childEndpoints[i].key, r.value);
          }
        });
        setChildLatency(childNext);
      }
      setManual(next);
    } finally {
      setPinging(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight text-foreground">Servers</h2>
          {engine && (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5",
                "text-[10px] font-mono uppercase tracking-wider",
                engine === "xray"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
              )}
              title={`Active VPN engine: ${engine}`}
            >
              {engine}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-label="Add subscription"
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20 active:scale-95 transition"
          >
            <Plus className="h-4 w-4 stroke-[2.5]" />
          </button>
        </div>
      </div>

      {profiles.length === 0 && subs.every((s) => s.kind === "auto" || s.children.length === 0) ? (
        <EmptyState
          icon={Server}
          title="No servers yet"
          hint="Use + to paste either a subscription URL or a direct share link; your servers will appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {/* Bundle subscriptions: each one shows its children as
              pickable rows. Bundle children carry a full engine
              config (sing-box or xray) and are not probeable, so
              they get a different row layout (no flag, no latency
              badge) but share the same "selected" affordance.
              2026-08-20. */}
          {subs
            .filter(
              (s) =>
                (s.kind === "singbox_bundle" || s.kind === "xray_bundle") &&
                s.children.length > 0,
            )
            .map((s) => {
              const blockId = `bundle-${s.id}`;
              const collapsed = isBlockCollapsed(blockId);
              return (
              <SectionCard key={blockId}>
                <button
                  type="button"
                  onClick={() => toggleBlock(blockId)}
                  aria-expanded={!collapsed}
                  className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left active:bg-accent/40"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold tracking-tight">
                      {s.name}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {s.children.length}
                    </span>
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                      collapsed && "-rotate-90",
                    )}
                  />
                </button>
                {!collapsed && (
                  <ul className="divide-y divide-border">
                    {s.children.map((child) => {
                      const isSel =
                        !!activeBundle &&
                        activeBundle.subscriptionId === s.id &&
                        activeBundle.childKey === child.key;
                      return (
                        <li key={`bundle-child-${s.id}-${child.key}`}>
                          <button
                            type="button"
                            onClick={() =>
                              void onSelectBundleChild({
                                subscriptionId: s.id,
                                childKey: child.key,
                                engine: child.engine === "xray" ? "xray" : "singbox",
                                childName: child.name,
                              })
                            }
                            className={cn(
                              "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors",
                              isSel ? "bg-foreground/5" : "active:bg-accent/60",
                            )}
                          >
                            <span
                              className={cn(
                                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                                isSel
                                  ? "border-emerald-400/70"
                                  : "border-muted-foreground/40",
                              )}
                              aria-hidden
                            >
                              {isSel && (
                                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {child.name}
                              </span>
                              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                {child.endpoint
                                  ? `${child.endpoint.host}:${child.endpoint.port}`
                                  : child.engine === "xray"
                                    ? "xray config"
                                    : "sing-box config"}
                              </span>
                            </span>
                            {child.endpoint ? (
                              <LatencyBadge
                                ms={childLatency.get(`${s.id}:${child.key}`)}
                                dim={pinging && !childLatency.has(`${s.id}:${child.key}`)}
                              />
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </SectionCard>
              );
            })}
          {groups
            .filter((group) => group.entries.length > 0)
            .map((group) => {
              const collapsible = group.kind === "subscription";
              const collapsed = collapsible && isBlockCollapsed(group.id);
              return (
            <SectionCard key={group.id}>
              {collapsible ? (
                <button
                  type="button"
                  onClick={() => toggleBlock(group.id)}
                  aria-expanded={!collapsed}
                  className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left active:bg-accent/40"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold tracking-tight">
                      {group.label}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {group.entries.length}
                    </span>
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                      collapsed && "-rotate-90",
                    )}
                  />
                </button>
              ) : (
                <SectionHeader title={group.label} />
              )}
              {(!collapsible || !collapsed) && (
                <ul className="divide-y divide-border">
                  {group.entries.map(({ profile: o, profileIndex: i }) => {
                    const supported = isSupported(o);
                    const isSel = i === selectedIndex;
                    const ms =
                      supported && latencyByTag.has(o.tag)
                        ? latencyByTag.get(o.tag)
                        : undefined;
                    const { code } = flagForProfile({
                      tag: supported ? o.tag : undefined,
                      server: supported ? o.server : undefined,
                      geoipByIp,
                    });
                    const deletable = group.kind === "manual";
                    return (
                      <li
                        key={`srv-${i}-${supported ? profileEndpoint(o) : "x"}`}
                        className="flex items-center"
                      >
                        <button
                          type="button"
                          onClick={() => supported && onSelect(i)}
                          disabled={!supported}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left transition-colors",
                            isSel ? "bg-foreground/5" : "active:bg-accent/60",
                            !supported && "opacity-50",
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                              isSel
                                ? "border-emerald-400/70"
                                : "border-muted-foreground/40",
                            )}
                            aria-hidden
                          >
                            {isSel && (
                              <span className="h-2 w-2 rounded-full bg-emerald-400" />
                            )}
                          </span>
                          <FlagIcon code={code} size={18} className="shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {profileLabel(o)}
                            </span>
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">
                              {supported ? profileEndpoint(o) : "unsupported link"}
                            </span>
                          </span>
                          <LatencyBadge ms={ms} dim={pinging && ms == null} />
                        </button>
                        {deletable && (
                          <button
                            type="button"
                            onClick={() =>
                              setPendingDelete({
                                kind: "manual",
                                key: "tag" in o ? o.tag : o.raw,
                                label: profileLabel(o),
                              })
                            }
                            aria-label={`Delete ${profileLabel(o)}`}
                            className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-destructive/10 active:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>
              );
            })}
        </div>
      )}

      {/* Subscriptions overview. */}
      {subs.length > 0 && (
        <SectionCard>
          <SectionHeader title="Subscriptions" />
          <ul className="divide-y divide-border">
            {subs.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-3.5 py-2.5">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{s.name}</p>
                  <p className="break-words text-[11px] text-muted-foreground">
                    {s.lastError ? (
                      <span className="text-destructive">{s.lastError}</span>
                    ) : (
                      `${s.serverCount ?? 0} servers`
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void onRefreshSub(s.id)}
                  disabled={subFetching[s.id]}
                  aria-label={`Refresh ${s.name}`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground active:bg-accent active:text-foreground disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      subFetching[s.id] && "animate-spin",
                    )}
                  />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setPendingDelete({
                      kind: "subscription",
                      key: s.id,
                      label: s.name,
                    })
                  }
                  aria-label={`Remove ${s.name}`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground active:bg-destructive/10 active:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={
          pendingDelete?.kind === "subscription"
            ? "Delete subscription?"
            : "Delete server?"
        }
        description={
          pendingDelete
            ? `“${pendingDelete.label}” will be removed from the list.`
            : undefined
        }
        onConfirm={() => {
          if (!pendingDelete) return;
          if (pendingDelete.kind === "manual") {
            onRemoveManual(pendingDelete.key);
          } else {
            onRemoveSub(pendingDelete.key);
          }
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
      <AddSubscriptionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onAdd={onAddSub}
        onAddLinks={onAddLinks}
      />
    </div>
  );
}

/** Latency badge uses the shared fast/medium/slow policy. */
function LatencyBadge({ ms, dim }: { ms: number | undefined; dim?: boolean }) {
  const tone = latencyTone(ms);
  if (tone === "pending") {
    return (
      <span
        aria-label={dim ? "Latency unavailable after ping" : "Latency not measured"}
        className={cn(
          "rounded-full border border-border px-2 py-0.5 font-mono text-[10px] tabular-nums",
          dim ? "text-muted-foreground/40" : "text-muted-foreground/70",
        )}
      >
        —
      </span>
    );
  }
  const toneClass =
    tone === "fast"
      ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
      : tone === "medium"
        ? "border-amber-400/30 bg-amber-500/10 text-amber-300"
        : "border-red-400/30 bg-red-500/10 text-red-300";
  return (
    <span
      aria-label={`Latency ${ms} milliseconds, ${tone}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] tabular-nums",
        toneClass,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {formatMs(ms)}
    </span>
  );
}
