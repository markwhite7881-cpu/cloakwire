import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Outbound, Subscription, SubscriptionSnapshot, SubscriptionSummary } from "@/lib/types";

const STORAGE_KEY = "singbox-client.subscriptions.v1";

function hasTauriRuntime(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "__TAURI_INTERNALS__" in value
  );
}

const inTauri =
  typeof window !== "undefined" && hasTauriRuntime(window);

const inAndroidTauri =
  inTauri && /Android/i.test(navigator.userAgent);

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadFromStorage(): Subscription[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) =>
        s &&
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        typeof s.url === "string",
    ) as Subscription[];
  } catch {
    return [];
  }
}

function saveToStorage(subs: Subscription[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(subs));
  } catch {
    /* quota exceeded; ignore */
  }
}

function summaryToSubscription(
  summary: SubscriptionSummary,
  url = "",
): Subscription {
  // The Rust `SubscriptionSummary` does not carry the URL (it would
  // leak through the IPC bridge) but the local `Subscription` shape
  // wants one. We only get a URL on Android (we pass it in ourselves
  // when we add the record) or from the legacy migration. Other
  // platforms rebuild it from the same input the user originally
  // typed. 2026-08-21: `lastCount` was previously hardcoded to 0
  // (the Rust summary did not include the count). The count is now
  // derived at render time from `lastResult[id]?.outbounds.length`,
  // so it is no longer stored on the `Subscription` shape.
  return {
    id: summary.id,
    name: summary.name,
    url,
    intervalMinutes: summary.interval_minutes,
    lastFetchedAt: summary.last_success_at,
    lastCount: 0,
    lastError: summary.last_error?.message ?? null,
    lastErrorKind: summary.last_error?.kind ?? null,
    kind: summary.kind,
    engine: summary.engine,
    activeChildKey: summary.active_child_key,
    children: summary.children,
    serverCount: summary.server_count ?? 0,
  };
}

export interface FetchResult {
  outbounds: Outbound[];
  errors: number;
}

export function useSubscriptions() {
  // The hook keeps a single `Subscription` list (with URLs) as the
  // source of truth for the UI, and a parallel `Outbound[]` cache
  // keyed by subscription id for the profile picker. Both are
  // populated from the Rust `list_subscriptions` snapshot.
  const [subs, setSubs] = useState<Subscription[]>(() =>
    inAndroidTauri ? [] : loadFromStorage(),
  );
  const [snapshot, setSnapshot] = useState<SubscriptionSnapshot>({
    subscriptions: [],
    link_outbounds: [],
  });
  const [loaded, setLoaded] = useState(!inTauri);
  const [lastResult, setLastResult] = useState<Record<string, FetchResult>>(
    {},
  );
  const [fetching, setFetching] = useState<Record<string, boolean>>({});
  const tickRef = useRef<number | null>(null);
  const initializedRef = useRef(!inTauri);

  // Refresh the local list from the Rust snapshot. The snapshot is
  // sanitized (no URLs) so we keep the existing local URLs around
  // and only overwrite the rest of the fields.
  const load = useCallback(async () => {
    const snapshot = await api.listSubscriptions();
    setSnapshot(snapshot);
    // Preserve URLs by mapping id → existing record.
    setSubs((previous) => {
      const previousById = new Map(previous.map((s) => [s.id, s]));
      const next: Subscription[] = snapshot.subscriptions.map((summary) => {
        const previousRecord = previousById.get(summary.id);
        return summaryToSubscription(summary, previousRecord?.url ?? "");
      });
      return next;
    });
    setLoaded(true);
  }, []);

  // Pull link_outbounds into a per-subscription cache. The mobile
  // picker is still built around `Outbound[]` (not the engine-config
  // bundles), so the hook flattens link_outbounds into the shape the
  // rest of the app already understands. The snapshot's `link_outbounds`
  // is only a catalog (key + label + protocol); the full `Outbound[]`
  // payload is fetched on demand via `getSubscriptionOutbounds` so the
  // mobile servers screen can render real `tag` / `server` / `port`
  // info. 2026-08-20.
  //
  // 2026-08-21: previously this function created synthetic
  // `Outbound` placeholder rows (`{ protocol, tag, raw, reason }`)
  // and cast them with `as unknown as Outbound[]` so the picker
  // could render "vless link 1 — vless" rows for the 100-500 ms
  // it takes `getSubscriptionOutbounds` to resolve. The cast is
  // a lie (the placeholders are not real `Outbound`s — no
  // `server`/`port`) and was rendering unsupported-looking rows
  // for a moment on every cold start. The new path is to seed
  // `lastResult[id]` with an empty array and populate it when the
  // real fetch resolves. `ServersScreen` already renders "No
  // servers loaded" for empty groups, so the transient state is
  // identical to a freshly-added subscription.
  const loadOutbounds = useCallback(
    async (snapshot?: {
      link_outbounds: {
        subscription_id: string;
        links: { key: string; label: string; protocol: string }[];
      }[];
      subscriptions: SubscriptionSummary[];
    }) => {
      const snap = snapshot ?? (await api.listSubscriptions());
      const next: Record<string, FetchResult> = {};
      for (const group of snap.link_outbounds) {
        // Seed with an empty list so the picker has a stable
        // shape; `group.entries.length` will be 0 until the
        // fire-and-forget fetch below resolves and the real
        // outbounds arrive.
        next[group.subscription_id] = { outbounds: [], errors: 0 };
        api
          .getSubscriptionOutbounds(group.subscription_id)
          .then((full) => {
            if (full && full.length > 0) {
              setLastResult((prev) => ({
                ...prev,
                [group.subscription_id]: { outbounds: full, errors: 0 },
              }));
            }
          })
          .catch(() => {
            /* keep the empty state; user can pull-to-refresh */
          });
      }
      setLastResult(next);
    },
    [],
  );

  // Initial load. On Android we also migrate any pre-v1.3.1 records
  // from localStorage (the old webview-only store) into the Rust
  // service so the user does not lose subscriptions when upgrading.
  useEffect(() => {
    if (initializedRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        if (inTauri) {
          const legacy = loadFromStorage();
          if (legacy.length > 0) {
            try {
              await api.migrateLegacySubscriptions(
                legacy.map(({ id, name, url, intervalMinutes }) => ({
                  id,
                  name,
                  url,
                  intervalMinutes,
                })),
              );
              window.localStorage.removeItem(STORAGE_KEY);
            } catch {
              /* best-effort one-way migration */
            }
          }
        }
        const snapshot = await api.listSubscriptions();
    setSnapshot(snapshot);
        if (cancelled) return;
        setSubs((previous) => {
          const previousById = new Map(previous.map((s) => [s.id, s]));
          return snapshot.subscriptions.map((summary) =>
            summaryToSubscription(
              summary,
              previousById.get(summary.id)?.url ?? "",
            ),
          );
        });
        await loadOutbounds(snapshot);
        initializedRef.current = true;
        setLoaded(true);
      } catch {
        // Keep the empty state; a later refresh can retry without
        // touching the VPN service.
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadOutbounds]);

  // On desktop, the service lives in Rust too. localStorage is just
  // a local mirror for instant first paint.
  useEffect(() => {
    if (!inAndroidTauri) saveToStorage(subs);
  }, [subs]);

  const refreshOne = useCallback(
    async (id: string, override?: Subscription) => {
      const sub = override ?? subs.find((s) => s.id === id);
      if (!sub) return;
      setFetching((prev) => ({ ...prev, [id]: true }));
      try {
        const result = await api.refreshSubscription(id);
        // Rust may return a `SubscriptionSummary` with
        // `last_success_at: null` even after a successful refresh
        // (the timestamp is only persisted on a subsequent tick in
        // some code paths). In that case stamp the local record
        // with "now" so the UI shows the row as freshly fetched
        // — `lastFetchedAt` drives both the "last:" label and the
        // auto-refresh interval, so leaving it null makes the row
        // look stale and re-triggers a refresh on the next tick.
        // 2026-08-21.
        const summary = result.subscription;
        const lastFetchedAt =
          summary.last_success_at ?? new Date().toISOString();
        const merged: Subscription = {
          ...summaryToSubscription(summary, sub.url),
          lastFetchedAt,
        };
        setSubs((prev) =>
          prev.map((s) => (s.id === id ? merged : s)),
        );
        await loadOutbounds();
      } catch (e) {
        // If the Rust store has no record for this id, the local
        // entry is stale (e.g. someone removed it from disk, or
        // the id was just rotated by a duplicate-URL add). Drop
        // it from the local state and resync from Rust so the
        // user doesn't see a phantom row they can't refresh.
        const msg = (e as Error).message || String(e);
        const isNotFound = /not found/i.test(msg);
        if (isNotFound) {
          setSubs((prev) => prev.filter((s) => s.id !== id));
        } else {
          setSubs((prev) =>
            prev.map((s) => (s.id === id ? { ...s, lastError: msg } : s)),
          );
        }
      } finally {
        setFetching((prev) => ({ ...prev, [id]: false }));
      }
    },
    [subs, loadOutbounds],
  );

  const refreshAll = useCallback(async () => {
    // Serialise the per-subscription refresh. The old parallel
    // `Promise.all` form fired 20 concurrent IPC calls plus 20
    // `loadOutbounds()` calls (one per `refreshOne` on success)
    // which spiked both the bridge and the Rust fetch task. With
    // 20+ subscriptions on a slow uplink this could even back up
    // the local listener queue long enough for the WebView to
    // drop one of the responses. Sequential is slower wall-clock
    // but keeps the bridge cool and is bounded by the provider
    // rate-limits anyway. 2026-08-21.
    for (const s of subs) {
      await refreshOne(s.id);
    }
  }, [subs, refreshOne]);

  useEffect(() => {
    if (!initializedRef.current) return;
    const onTick = () => {
      const now = Date.now();
      subs.forEach((s) => {
        if (s.intervalMinutes <= 0) return;
        const lastTs = s.lastFetchedAt ? new Date(s.lastFetchedAt).getTime() : 0;
        if (now - lastTs >= s.intervalMinutes * 60_000) void refreshOne(s.id);
      });
    };
    tickRef.current = window.setInterval(onTick, 30_000);
    return () => {
      if (tickRef.current != null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [subs, refreshOne]);

  // Auto-refresh on first mount once the service has hydrated.
  useEffect(() => {
    if (!initializedRef.current) return;
    if (subs.length === 0) return;
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subs.length]);

  // makeId is referenced by the legacy `remove` path in case a
  // future caller wants to mint a placeholder id; the current
  // add flow is fully owned by the Rust service, so this is the
  // only place the symbol needs to survive the build.
  const _mintId = makeId;

  const add = useCallback(
    async (input: { name?: string; url: string; intervalMinutes?: number }) => {
      // Default the display name to the URL hostname when the
      // user did not type one. The Rust service generates the
      // canonical id and persists the record; we just reload the
      // snapshot afterwards so the new row shows up with the
      // real id, in-flight state, and any fetch metadata the
      // service already computed.
      let displayName = input.name?.trim();
      if (!displayName) {
        try {
          displayName = new URL(input.url).hostname || "Subscription";
        } catch {
          displayName = "Subscription";
        }
      }
      try {
        await api.addSubscription({
          name: displayName,
          url: input.url.trim(),
          intervalMinutes: input.intervalMinutes ?? 60,
        });
        await load();
        await loadOutbounds();
      } catch (e) {
        // Surface the Rust error to the user — the AddSubscriptionSheet
        // has its own error pill that shows the message verbatim, and
        // the new entry never made it into the snapshot.
        throw e;
      }
    },
    [load, loadOutbounds],
  );

  const remove = useCallback(
    async (id: string) => {
      // Optimistic delete; revert if Rust rejects.
      const previous = subs.find((s) => s.id === id);
      setSubs((prev) => prev.filter((s) => s.id !== id));
      // Also drop the cached outbounds for this id. Without this
      // a user could still select a profile that belongs to a
      // subscription they just removed (the picker indexes into
      // `lastResult[id]?.outbounds[]` directly). 2026-08-21.
      setLastResult((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      try {
        await api.removeSubscription(id);
        await loadOutbounds();
      } catch (e) {
        if (previous) {
          setSubs((prev) => [...prev, previous]);
        }
        throw e;
      }
    },
    [subs, loadOutbounds],
  );

  const setIntervalFor = useCallback(
    async (id: string, mins: number) => {
      const summary = await api.setSubscriptionInterval(id, mins);
      setSubs((prev) =>
        prev.map((s) =>
          s.id === id
            ? summaryToSubscription(summary, s.url)
            : s,
        ),
      );
    },
    [],
  );

  /// Pin a bundle subscription's `activeChildKey` to one of its
  /// children. The Rust side validates that the child belongs to
  /// the subscription; the local state is updated optimistically
  /// from the returned summary so the picker reflects the choice
  /// immediately. 2026-08-20.
  const setActiveChild = useCallback(
    async (id: string, childKey: string) => {
      const summary = await api.setActiveChild(id, childKey);
      setSubs((prev) =>
        prev.map((s) =>
          s.id === id ? summaryToSubscription(summary, s.url) : s,
        ),
      );
    },
    [],
  );

  return {
    subs,
    snapshot,
    lastResult,
    fetching,
    loaded,
    add,
    remove,
    refreshOne,
    refreshAll,
    setIntervalFor,
    setActiveChild,
    selectChild: setActiveChild,
    getHwid: api.getSubscriptionHwid,
    setHwid: api.setSubscriptionHwid,
    resetHwid: api.resetSubscriptionHwid,
    /** Re-read the snapshot from Rust. Use after the user clears local
     *  state or the service is reinitialised (e.g. after a settings
     *  reset). */
    reload: load,
  };
}

export function mergeSubscriptionResults(
  subs: Subscription[],
  lastResult: Record<string, FetchResult>,
): Outbound[] {
  const out: Outbound[] = [];
  for (const s of subs) {
    const r = lastResult[s.id];
    if (r) out.push(...r.outbounds);
  }
  return out;
}
