import { ServerCheck } from "./ServerCheck";
import { AtlasHeading } from "@/components/atlas/AtlasHeading";
import {ProfileHealthBadge} from "./ProfileHealthBadge";
import {profileRef} from "@/lib/profileEvidence";
import { manualProfileHint } from "@/lib/manualProfileHint";
import { useState } from "react";
import { Plus, Server, Trash2 } from "lucide-react";
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
import type { HomeProfileMetadata, SubscriptionSummary } from "@/lib/types";
import type { ConnectionProfile } from "@/lib/connectionProfiles";

export interface ServersTabProps {
  profiles: ConnectionProfile[];
  onOpenImport: () => void;
  onRemove: (index: number) => void;
  onClearAll: () => void;
  subs: SubscriptionSummary[];
  subFetching: Record<string, boolean>;
  onRename: (id: string, name: string) => Promise<void>;
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
  onOpenImport,
  onRemove,
  onClearAll,
  subs,
  subFetching,
  onRename,
  onRemoveSub,
  onRefreshSub,
  onRefreshAllSubs,
  onSetSubInterval,
  onSelectSubChild,
  geoipByIp,
}: ServersTabProps) {
  const { t } = useI18n();
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
        actions={<Button size="sm" variant="outline" aria-haspopup="dialog" onClick={onOpenImport}>
          <Plus size={15}/>{t("common.add")}</Button>}/>

      <div className="atlas-directory">
            <SubscriptionsCard expanded={subOpen} onToggle={()=>setSubOpen(v=>!v)}
              subs={subs}
              fetching={subFetching}
              onRemove={onRemoveSub}
              onRefresh={onRefreshSub}
              onRefreshAll={onRefreshAllSubs}
              onRename={onRename}
              onIntervalChange={onSetSubInterval}
              onSelectChild={onSelectSubChild}
            />
      </div>

      {profiles.some(p=>p.kind!=="manual")&&<Card className="atlas-section"><CardHeader><CardTitle>{t("atlas.subscriptionProfiles")}</CardTitle></CardHeader><CardContent>
        <ul className="space-y-2">{profiles.filter(p=>p.kind!=="manual").map(profile=><li key={JSON.stringify(profileRef(profile))} className="atlas-record">
          <span className="break-words text-sm">{profile.kind==="subscription"?profile.label:profile.kind==="ready_config"?profile.name:""}</span>
          <ProfileHealthBadge profileRef={profileRef(profile)}/>
          <ServerCheck profileRef={profileRef(profile)} />
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
