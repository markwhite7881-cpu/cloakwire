import { useState } from "react";
import { Link2, Loader2, Plus, Rss, Trash2 } from "lucide-react";
import { Button } from "@/components/Button";
import { Badge } from "@/components/Badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/Card";
import { ProfileCard } from "@/components/ProfileCard";
import { SubscriptionsCard } from "@/components/SubscriptionsCard";
import { cn } from "@/lib/utils";
import { profileLabel } from "@/lib/outbound";
import type { HomeProfileMetadata, ParseFailure, SubscriptionSummary } from "@/lib/types";
import type { ConnectionProfile } from "@/lib/connectionProfiles";

export interface ServersTabProps {
  profiles: ConnectionProfile[];
  parseErrors: ParseFailure[];
  /** Top-level error from the last Parse attempt (e.g. command-not-found). */
  parseError: string | null;
  pendingLinks: string;
  onPendingLinksChange: (v: string) => void;
  onParse: () => void;
  onRemove: (index: number) => void;
  onClearAll: () => void;
  parsing: boolean;
  // Subscriptions
  subs: SubscriptionSummary[];
  subFetching: Record<string, boolean>;
  onAddSub: (sub: { url: string; name?: string; intervalMinutes?: number }) => void;
  onRemoveSub: (id: string) => void;
  onRefreshSub: (id: string) => void;
  onRefreshAllSubs: () => void;
  onSetSubInterval: (id: string, minutes: number) => void;
  onSelectSubChild: (subscriptionId: string, childKey: string) => void;
  /** ip → country code from the GeoIP cache (useGeoIp). */
  geoipByIp: Record<string, string>;
  /** Safe country metadata for ready Xray profiles, keyed by `${subscriptionId}:${key}`. */
  readyProfileMetadata: ReadonlyMap<string, HomeProfileMetadata>;
}

export function ServersTab({
  profiles,
  parseErrors,
  parseError,
  pendingLinks,
  onPendingLinksChange,
  onParse,
  onRemove,
  onClearAll,
  parsing,
  subs,
  subFetching,
  onAddSub,
  onRemoveSub,
  onRefreshSub,
  onRefreshAllSubs,
  onSetSubInterval,
  onSelectSubChild,
  geoipByIp,
}: ServersTabProps) {
  const [addOpen, setAddOpen] = useState(true);
  const [subOpen, setSubOpen] = useState(true);

  const manualProfiles = profiles
    .map((profile, index) => ({ profile, index }))
    .filter(
      (item): item is { profile: Extract<ConnectionProfile, { kind: "manual" }>; index: number } =>
        item.profile.kind === "manual",
    );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6">
      {/* ─── Add: one input, two kinds of payload ───────────────────── */}
      <Card className="bento-card">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-emerald-400" />
                Add Servers & Subscriptions
              </CardTitle>
              <CardDescription>
                One entry per line — accepts share-links (vless://, vmess://,
                ss://, hy2://, trojan://, tuic://) and subscription URLs
                (https://…). Auto-detected.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddOpen((v) => !v)}
              className="text-xs"
            >
              {addOpen ? "Hide" : "Add"}
            </Button>
          </div>
        </CardHeader>
        {addOpen && (
          <CardContent className="space-y-3">
            <textarea
              value={pendingLinks}
              onChange={(e) => onPendingLinksChange(e.target.value)}
              placeholder={
                "vless://uuid@host:port?type=tcp&security=reality&pbk=...\n" +
                "https://provider.example.com/sub?token=ABCD-1234"
              }
              className={cn(
                "min-h-[110px] w-full resize-y rounded-xl border border-border/80 bg-[#07080c] px-3.5 py-2.5",
                "font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50",
                "focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40",
              )}
              spellCheck={false}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={onParse}
                disabled={parsing || !pendingLinks.trim()}
                className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium transition"
              >
                {parsing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                )}
                Import server or subscription
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPendingLinksChange("")}
                title="Clear input"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {parseError && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {parseError}
              </div>
            )}
            {parseErrors.length > 0 && (
              <div className="space-y-1.5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs">
                <p className="font-semibold text-destructive">
                  {parseErrors.length} parse error
                  {parseErrors.length === 1 ? "" : "s"}:
                </p>
                <ul className="space-y-0.5 pl-1 font-mono text-destructive/90 text-[11px]">
                  {parseErrors.slice(0, 3).map((f, i) => (
                    <li key={i} className="truncate">
                      <span className="text-muted-foreground">
                        [{f.error.kind}]
                      </span>{" "}
                      {f.error.message}
                    </li>
                  ))}
                  {parseErrors.length > 3 && (
                    <li className="text-muted-foreground">
                      …and {parseErrors.length - 3} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* ─── Subscriptions (collapsible sub-section) ───────────────── */}
      <Card className="bento-card">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Rss className="h-4 w-4 text-emerald-400" />
                Subscriptions
                <Badge
                  variant="secondary"
                  className="px-2 py-0.5 text-xs font-mono bg-emerald-950/60 text-emerald-400 border border-emerald-800/60"
                >
                  {subs.length}
                </Badge>
              </CardTitle>
              <CardDescription>
                Subscription providers fetched automatically. Select specific servers from the Home tab.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSubOpen((v) => !v)}
              className="text-xs"
            >
              {subOpen ? "Hide" : "Manage"}
            </Button>
          </div>
        </CardHeader>
        {subOpen && (
          <CardContent>
            <SubscriptionsCard
              subs={subs}
              fetching={subFetching}
              onAdd={onAddSub}
              onRemove={onRemoveSub}
              onRefresh={onRefreshSub}
              onRefreshAll={onRefreshAllSubs}
              onIntervalChange={onSetSubInterval}
              onSelectChild={onSelectSubChild}
            />
          </CardContent>
        )}
      </Card>

      {/* ─── Profile list: Custom / Manual Servers ───────────────────── */}
      <Card className="bento-card">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                Custom Servers
                <Badge
                  variant="secondary"
                  className="px-2 py-0.5 text-xs font-mono bg-secondary text-foreground border border-border/80"
                >
                  {manualProfiles.length}
                </Badge>
              </CardTitle>
              <CardDescription>
                Manually added proxies (share-links). Subscriptions are managed separately above.
              </CardDescription>
            </div>
            {manualProfiles.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (window.confirm("Remove all manually added custom servers?")) onClearAll();
                }}
                title="Remove all custom servers"
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Clear manual
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {manualProfiles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/80 bg-[#07080c]/60 p-8 text-center text-sm text-muted-foreground">
              No custom servers yet. Add individual share-links above.
            </div>
          ) : (
            <div className="space-y-2">
              {manualProfiles.map(({ profile, index }) => (
                <ProfileCard
                  key={`manual-${index}`}
                  outbound={profile.outbound}
                  geoipByIp={geoipByIp}
                  onRemove={() => {
                    if (window.confirm(`Remove server “${profileLabel(profile.outbound)}”?`)) onRemove(index);
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
