import { AtlasHeading } from "@/components/atlas/AtlasHeading";
import {ProfileHealthBadge} from "./ProfileHealthBadge";
import {profileRef} from "@/lib/profileEvidence";
import { manualProfileHint } from "@/lib/manualProfileHint";
import { useState } from "react";
import { Link2, Loader2, Plus, Rss, Server, Trash2 } from "lucide-react";
import { Button } from "@/components/Button";
import { Badge } from "@/components/Badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/Card";
import { ProfileCard } from "@/components/ProfileCard";
import { SubscriptionsCard } from "@/components/SubscriptionsCard";
import { cn } from "@/lib/utils";
import { profileLabel } from "@/lib/outbound";
import { useI18n } from "@/lib/i18n";
import type { HomeProfileMetadata, ParseFailure, SubscriptionSummary } from "@/lib/types";
import type { ConnectionProfile } from "@/lib/connectionProfiles";

export interface ServersTabProps {
  profiles: ConnectionProfile[];
  parseErrors: ParseFailure[];
  parseError: string | null;
  pendingLinks: string;
  onPendingLinksChange: (v: string) => void;
  onParse: () => void;
  onRemove: (index: number) => void;
  onClearAll: () => void;
  parsing: boolean;
  subs: SubscriptionSummary[];
  subFetching: Record<string, boolean>;
  onAddSub: (sub: { url: string; name?: string; intervalMinutes?: number }) => void;
  onRemoveSub: (id: string) => void;
  onRefreshSub: (id: string) => void;
  onRefreshAllSubs: () => void;
  onSetSubInterval: (id: string, minutes: number) => void;
  onSelectSubChild: (subscriptionId: string, childKey: string) => void;
  geoipByIp: Record<string, string>;
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
  const { t } = useI18n();
  const [addOpen, setAddOpen] = useState(true);
  const [subOpen, setSubOpen] = useState(true);

  const manualProfiles = profiles
    .map((profile, index) => ({ profile, index }))
    .filter(
      (item): item is { profile: Extract<ConnectionProfile, { kind: "manual" }>; index: number } =>
        item.profile.kind === "manual",
    );

  return (
    <div className="atlas-page atlas-catalog">
      <AtlasHeading icon={Server} title={t("servers.title")} meta={<span className="atlas-count">{profiles.length}</span>}
        actions={<Button size="sm" variant="outline" aria-expanded={addOpen} aria-controls="atlas-import" onClick={()=>setAddOpen(v=>!v)}>
          <Link2 size={15}/>{addOpen?t("common.close"):t("common.add")}</Button>}/>
      {addOpen && <section id="atlas-import" className="atlas-import">
        <h3><Link2 size={16}/>{t("servers.addServer")}</h3>
        <div className="space-y-3">
            <textarea aria-label={t("servers.addServer")}
              value={pendingLinks} onChange={(e)=>onPendingLinksChange(e.target.value)}
              placeholder={"vless://…\nhttps://provider.example.com/sub?token=…"}
              className={cn(
                "min-h-[110px] w-full resize-y rounded-xl border border-border/80 bg-[var(--atlas-field)] px-3.5 py-2.5",
                "font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50",
                "focus:border-theme-accent focus:outline-none focus:ring-1 focus:ring-theme-accent",
              )}
              spellCheck={false}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={onParse}
                disabled={parsing || !pendingLinks.trim()}
                className="flex-1 bg-theme-accent hover:opacity-90 text-zinc-950 font-medium transition"
              >
                {parsing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t("servers.addServer")}
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
        </div>
      </section>}

      <div className="atlas-directory">
            <SubscriptionsCard expanded={subOpen} onToggle={()=>setSubOpen(v=>!v)}
              subs={subs}
              fetching={subFetching}
              onAdd={onAddSub}
              onRemove={onRemoveSub}
              onRefresh={onRefreshSub}
              onRefreshAll={onRefreshAllSubs}
              onIntervalChange={onSetSubInterval}
              onSelectChild={onSelectSubChild}
            />
      </div>

      {profiles.some(p=>p.kind!=="manual")&&<Card className="atlas-section"><CardHeader><CardTitle>{t("atlas.subscriptionProfiles")}</CardTitle></CardHeader><CardContent>
        <ul className="space-y-2">{profiles.filter(p=>p.kind!=="manual").map(profile=><li key={JSON.stringify(profileRef(profile))} className="atlas-record">
          <span className="break-words text-sm">{profile.kind==="subscription"?profile.label:profile.kind==="ready_config"?profile.name:""}</span>
          <ProfileHealthBadge profileRef={profileRef(profile)}/>
        </li>)}</ul>
      </CardContent></Card>}
      {/* ─── Profile list: Custom / Manual Servers ───────────────────── */}
      <Card className="atlas-section">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Server className="h-4 w-4 text-theme-accent" />
              {t("atlas.customProfiles")}
              <Badge
                variant="secondary"
                className="badge-theme px-2 py-0.5 text-xs font-mono"
              >
                {manualProfiles.length}
              </Badge>
            </CardTitle>
            {manualProfiles.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (window.confirm(t("servers.clearManualConfirm"))) onClearAll();
                }}
                title={t("servers.clearManual")}
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {t("servers.clearManual")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {manualProfiles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/80 bg-[var(--atlas-field)] p-8 text-center text-sm text-muted-foreground">
              {t("servers.noCustomServers")}
            </div>
          ) : (
            <div className="space-y-2">
              {manualProfiles.map(({ profile, index }) => (
                <ProfileCard
                  key={profile.id ?? `manual-${index}`}
                  outbound={profile.outbound}
                  manualId={profile.id}
                  identityHint={profile.id ? manualProfileHint(profile.id,manualProfiles.flatMap(p=>p.profile.id?[p.profile.id]:[])) : undefined}
                  geoipByIp={geoipByIp}
                  onRemove={() => {
                    if (window.confirm(t("servers.removeConfirm", { name: profileLabel(profile.outbound) }))) onRemove(index);
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
