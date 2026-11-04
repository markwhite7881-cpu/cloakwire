import { useState } from "react";
import { Pencil, ExternalLink, Loader2, RefreshCw, Rss, Trash2 } from "lucide-react";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { ProviderMetadata, SubscriptionSummary } from "@/lib/types";

export interface SubscriptionsCardProps {
  subs: SubscriptionSummary[];
  fetching: Record<string, boolean>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => void;
  onRefresh: (id: string) => void;
  onRefreshAll: () => void;
  onIntervalChange: (id: string, minutes: number) => void;
  onSelectChild: (subscriptionId: string, childKey: string) => void;
  expanded?: boolean;
  onToggle?: () => void;
  onApply?: () => void;
  available?: never;
}

export function SubscriptionsCard({
  subs,
  fetching,
  onRemove,
  onRefresh,
  onRename,
  onRefreshAll,
  onIntervalChange,
  onSelectChild,
  expanded = true,
  onToggle,
}: SubscriptionsCardProps) {
  const { t } = useI18n();
  return (
    <div className="atlas-section">
      <div className="atlas-section-head">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <Rss className="h-4 w-4 text-muted-foreground" />
            {t("servers.subscriptions")}
            {subs.length > 0 && (
              <Badge variant="outline">{subs.length}</Badge>
            )}
          </h3>
          <div className="flex items-center gap-1">
            {onToggle && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={onToggle}>{t(expanded?"common.close":"common.edit")}</Button>}
            {subs.length > 0 && (
              <Button variant="ghost" size="icon"  onClick={onRefreshAll} title={t("servers.updateAll")}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("servers.providerMetaNote")}
        </p>
      </div>
      {expanded && <div className="atlas-section-body space-y-2">
        {subs.length === 0 && (
          <p className="rounded border border-border bg-card/40 p-3 text-[11px] text-muted-foreground">
            {t("servers.noSubscriptionsHint")}
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
                if (window.confirm(t("servers.removeSubscriptionConfirm", { name: subscription.name }))) onRemove(subscription.id);
              }}
              onRename={name => onRename(subscription.id, name)}
              onIntervalChange={(minutes) => onIntervalChange(subscription.id, minutes)}
              onSelectChild={(childKey) => onSelectChild(subscription.id, childKey)}
            />
          ))}
        </div>
      </div>}
    </div>
  );
}

function SubscriptionRow({ sub, loading, onRename, onRefresh, onRemove, onIntervalChange, onSelectChild }: {
  sub: SubscriptionSummary;
  loading: boolean;
  onRename: (name: string) => Promise<void>;
  onRefresh: () => void;
  onRemove: () => void;
  onIntervalChange: (minutes: number) => void;
  onSelectChild: (childKey: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    if (!draft?.trim() || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await onRename(draft.trim());
      setDraft(null);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  const fetched = sub.last_success_at ? new Date(sub.last_success_at).toLocaleString() : "—";
  const title = sub.metadata.profile_title?.trim();
  const engine = sub.kind === "link_list" ? "sing-box" : sub.engine === "xray" ? "Xray" : sub.engine === "singbox" ? "sing-box" : null;
  const serverCount = sub.server_count ?? (sub.kind === "link_list" ? 0 : sub.children.length);

  return (
    <div className="atlas-subscription-row">
      <div className="flex items-center gap-2">
        <Rss className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium" title={sub.name}>{sub.name}</span>
        {engine && <Badge variant="secondary">{engine}</Badge>}
        <Badge variant="outline">{t("servers.nodesCount", { count: serverCount })}</Badge>
        {sub.last_error && (
          <span className="rounded bg-destructive/10 px-1.5 py-0 text-[10px] text-destructive" title={sub.last_error.message}>
            {sub.last_error.kind || "error"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" disabled={saving} title={t("servers.rename")}
            onClick={() => { setDraft(sub.name); setFailed(false); }}><Pencil size={14}/></Button>
          <Button variant="ghost" size="icon"  onClick={onRefresh} disabled={loading} title={t("servers.refreshNow")}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon"  onClick={onRemove} title={t("servers.deleteSubscription")}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {draft !== null && <form onSubmit={saveName} className="mt-2 flex flex-wrap items-center gap-2">
        <input className="atlas-input min-w-0 flex-1" aria-label={t("servers.name")} autoFocus
          disabled={saving} value={draft} maxLength={160} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") setDraft(null); }}/>
        <Button type="submit" size="sm" disabled={saving || !draft.trim()}>{t("common.save")}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>{t("common.cancel")}</Button>
        {failed && <p role="alert" className="text-destructive">{t("servers.renameFailed")}</p>}
      </form>}
      {title && title !== sub.name && <p className="mt-1 truncate text-[11px] text-muted-foreground">{t("servers.provider", { name: title })}</p>}

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span>{t("servers.lastUpdated")}: {fetched}</span><span>·</span>
        <span className={cn(sub.last_error ? "text-destructive" : "text-foreground/70")}>{sub.last_error?.message ?? t("common.ready")}</span><span>·</span>
        <select value={sub.interval_minutes} onChange={(event) => onIntervalChange(parseInt(event.target.value, 10))} className="atlas-input">
          <option value={15}>15m</option><option value={30}>30m</option><option value={60}>1h</option><option value={360}>6h</option><option value={1440}>24h</option>
        </select>
      </div>

      <MetadataSummary metadata={sub.metadata} />

      {sub.children.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" aria-label="Subscription configuration selection">
          {sub.children.map((child) => {
            const active = sub.active_child_key === child.key;
            return (
              <Button key={child.key} type="button" variant={active ? "secondary" : "ghost"} size="sm"  onClick={() => onSelectChild(child.key)} aria-pressed={active} title={`Select ${child.name}`}>
                <Badge variant="outline">{child.engine === "singbox" ? "sing-box" : "Xray"}</Badge>
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
  const { t } = useI18n();
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
            <span>{t("servers.trafficUsed", { used: used == null ? "—" : formatBytes(used) })}</span>
            {total != null && <span>{t("servers.trafficRemaining", { remaining: formatBytes(Math.max(0, total - (used ?? 0))), total: formatBytes(total) })}</span>}
          </div>
          {percent != null && <div className="h-1 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${percent}%` }} /></div>}
        </>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {expires && <span>{t("servers.expireDate")}: {formatDate(expires)}</span>}
        {metadata.profile_web_page_url && <MetadataLink label={t("servers.providerPage")} url={metadata.profile_web_page_url} />}
        {metadata.support_url && <MetadataLink label={t("servers.support")} url={metadata.support_url} />}
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
