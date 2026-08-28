import { useState } from "react";
import { ExternalLink, Loader2, Plus, RefreshCw, Rss, Trash2 } from "lucide-react";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { cn } from "@/lib/utils";
import type { ProviderMetadata, SubscriptionSummary } from "@/lib/types";

export interface SubscriptionsCardProps {
  subs: SubscriptionSummary[];
  fetching: Record<string, boolean>;
  onAdd: (input: { name?: string; url: string; intervalMinutes?: number }) => void;
  onRemove: (id: string) => void;
  onRefresh: (id: string) => void;
  onRefreshAll: () => void;
  onIntervalChange: (id: string, minutes: number) => void;
  onSelectChild: (subscriptionId: string, childKey: string) => void;
  onApply?: () => void;
  available?: never;
}

export function SubscriptionsCard({
  subs,
  fetching,
  onAdd,
  onRemove,
  onRefresh,
  onRefreshAll,
  onIntervalChange,
  onSelectChild,
}: SubscriptionsCardProps) {
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftInterval, setDraftInterval] = useState(60);

  const onSubmit = () => {
    if (!draftUrl.trim()) return;
    onAdd({
      name: draftName.trim() || undefined,
      url: draftUrl.trim(),
      intervalMinutes: draftInterval,
    });
    setDraftName("");
    setDraftUrl("");
    setAdding(false);
  };

  return (
    <div className="bento-card rounded-2xl border border-border/80 text-card-foreground shadow-lg">
      <div className="flex flex-col space-y-1 p-5 pb-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <Rss className="h-4 w-4 text-muted-foreground" />
            Subscriptions
            {subs.length > 0 && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{subs.length}</Badge>
            )}
          </h3>
          <div className="flex gap-1">
            {subs.length > 0 && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRefreshAll} title="Refresh all">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setAdding((value) => !value)} title="Add subscription">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Provider URLs stay in the Rust backend. The UI receives only sanitized status, usage and expiry metadata.
        </p>
      </div>
      <div className="space-y-2 p-5 pt-0">
        {adding && (
          <div className="space-y-2 rounded-md border border-border bg-card/40 p-3">
            <input type="text" placeholder="Name (optional)" value={draftName} onChange={(event) => setDraftName(event.target.value)} className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs" />
            <input type="url" placeholder="https://provider.example.com/sub?token=…" value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} className="w-full rounded border border-input bg-background px-2 py-1.5 font-mono text-[11px]" />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                refresh every
                <select value={draftInterval} onChange={(event) => setDraftInterval(parseInt(event.target.value, 10))} className="rounded border border-input bg-background px-1 py-0.5 font-mono text-[11px]">
                  <option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>1 h</option><option value={360}>6 h</option><option value={1440}>daily</option>
                </select>
              </label>
              <Button size="sm" onClick={onSubmit} disabled={!draftUrl.trim()} className="ml-auto">Add</Button>
            </div>
          </div>
        )}

        {subs.length === 0 && !adding && (
          <p className="rounded border border-border bg-card/40 p-3 text-[11px] text-muted-foreground">
            No subscriptions yet. Click <strong>+</strong> to add a URL. Stored securely by the backend.
          </p>
        )}

        <div className="space-y-1.5">
          {subs.map((subscription) => (
            <SubscriptionRow
              key={subscription.id}
              sub={subscription}
              loading={!!fetching[subscription.id]}
              onRefresh={() => onRefresh(subscription.id)}
              onRemove={() => {
                if (window.confirm(`Remove subscription “${subscription.name}” and all of its imported servers?`)) onRemove(subscription.id);
              }}
              onIntervalChange={(minutes) => onIntervalChange(subscription.id, minutes)}
              onSelectChild={(childKey) => onSelectChild(subscription.id, childKey)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SubscriptionRow({ sub, loading, onRefresh, onRemove, onIntervalChange, onSelectChild }: {
  sub: SubscriptionSummary;
  loading: boolean;
  onRefresh: () => void;
  onRemove: () => void;
  onIntervalChange: (minutes: number) => void;
  onSelectChild: (childKey: string) => void;
}) {
  const fetched = sub.last_success_at ? new Date(sub.last_success_at).toLocaleString() : "—";
  const title = sub.metadata.profile_title?.trim();
  const engine = sub.kind === "link_list" ? "sing-box" : sub.engine === "xray" ? "Xray" : sub.engine === "singbox" ? "sing-box" : null;
  const serverCount = sub.server_count ?? (sub.kind === "link_list" ? 0 : sub.children.length);

  return (
    <div className="rounded-md border border-border bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <Rss className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium" title={sub.name}>{sub.name}</span>
        {engine && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{engine}</Badge>}
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{serverCount} server{serverCount === 1 ? "" : "s"}</Badge>
        {sub.last_error && (
          <span className="rounded bg-destructive/10 px-1.5 py-0 text-[10px] text-destructive" title={sub.last_error.message}>
            {sub.last_error.kind || "error"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRefresh} disabled={loading} title="Refresh now">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRemove} title="Remove subscription">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {title && title !== sub.name && <p className="mt-1 truncate text-[11px] text-muted-foreground">Provider: {title}</p>}

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span>last: {fetched}</span><span>·</span>
        <span className={cn(sub.last_error ? "text-destructive" : "text-foreground/70")}>{sub.last_error?.message ?? "ready"}</span><span>·</span>
        <select value={sub.interval_minutes} onChange={(event) => onIntervalChange(parseInt(event.target.value, 10))} className="rounded border border-input bg-background px-1 py-0 font-mono text-[10px]">
          <option value={15}>15m</option><option value={30}>30m</option><option value={60}>1h</option><option value={360}>6h</option><option value={1440}>24h</option>
        </select>
      </div>

      <MetadataSummary metadata={sub.metadata} />

      {sub.children.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" aria-label="Subscription configuration selection">
          {sub.children.map((child) => {
            const active = sub.active_child_key === child.key;
            return (
              <Button key={child.key} type="button" variant={active ? "secondary" : "ghost"} size="sm" className="h-7 gap-1 px-2 text-[10px]" onClick={() => onSelectChild(child.key)} aria-pressed={active} title={`Select ${child.name}`}>
                <Badge variant="outline" className="px-1 py-0 text-[9px]">{child.engine === "singbox" ? "sing-box" : "Xray"}</Badge>
                <span className="max-w-36 truncate">{child.name}</span>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MetadataSummary({ metadata }: { metadata: ProviderMetadata }) {
  const upload = metadata.upload_bytes ?? metadata.userinfo?.upload ?? null;
  const download = metadata.download_bytes ?? metadata.userinfo?.download ?? null;
  const total = metadata.total_bytes ?? metadata.userinfo?.total ?? null;
  const used = upload == null && download == null ? null : (upload ?? 0) + (download ?? 0);
  const expires = metadata.expires_at ?? metadata.userinfo?.expire ?? null;
  const percent = used != null && total != null && total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : null;
  const hasLinks = !!metadata.profile_web_page_url || !!metadata.support_url;
  if (used == null && total == null && !expires && !hasLinks) return null;

  return (
    <div className="mt-2 space-y-1.5 rounded border border-border/70 bg-background/40 p-2 text-[10px] text-muted-foreground">
      {(used != null || total != null) && (
        <>
          <div className="flex justify-between gap-3">
            <span>Traffic: {used == null ? "—" : formatBytes(used)} used</span>
            {total != null && <span>{formatBytes(Math.max(0, total - (used ?? 0)))} remaining / {formatBytes(total)}</span>}
          </div>
          {percent != null && <div className="h-1 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${percent}%` }} /></div>}
        </>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {expires && <span>Expires: {formatDate(expires)}</span>}
        {metadata.profile_web_page_url && <MetadataLink label="Provider page" url={metadata.profile_web_page_url} />}
        {metadata.support_url && <MetadataLink label="Support" url={metadata.support_url} />}
      </div>
    </div>
  );
}

function MetadataLink({ label, url }: { label: string; url: string }) {
  return <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground/80 underline decoration-dotted underline-offset-2">{label}<ExternalLink className="h-2.5 w-2.5" /></a>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
