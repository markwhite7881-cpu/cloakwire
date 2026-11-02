import {useI18n} from "@/lib/i18n";
import {RefreshCw,X} from "lucide-react";
import {ProfileHealthBadge} from "@/components/ProfileHealthBadge";
import type {ProfileSource} from "@/lib/profileEvidence";
import type {useProfileProbe} from "../useProfileProbe";

export function ProfileProbeCard({probe,source,disabled}:{probe:ReturnType<typeof useProfileProbe>;source:ProfileSource|null;disabled:boolean}){
 const {t}=useI18n(),health=probe.health;
 const reason=health?.issue?t("health.reasons."+health.issue):probe.error?t("health.reasons.unknown"):null;
 const hasResult=!!health||probe.error;
 const actionLabel=t(probe.busy?"profileProbe.cancel":"profileProbe.check");
 return <section aria-label={t("profileProbe.title")} data-testid="profile-probe-card" className="relative z-10 min-w-0 text-xs">
  <div className="flex flex-wrap items-center gap-2">
   <div className="min-w-0 flex-1 basis-32 break-words">
    {source?<ProfileHealthBadge profileRef={source.profile_ref} accessOnly/>:<p className="text-muted-foreground">{t("profileProbe.choose")}</p>}
   </div>
   <button type="button" data-testid="profile-probe-button" aria-label={actionLabel} title={actionLabel} disabled={disabled||!source}
    className="inline-flex min-h-11 min-w-11 max-w-full shrink-0 items-center justify-center gap-2 rounded-lg px-2 font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
    onClick={()=>void (probe.busy?probe.cancel():probe.check()).catch(()=>{})}>
    {probe.busy?<X aria-hidden="true" className="h-4 w-4"/>:<RefreshCw aria-hidden="true" className="h-4 w-4"/>}
    {(!hasResult||probe.busy)&&<span>{actionLabel}</span>}
   </button>
  </div>
  {reason&&<details className="mt-2 text-muted-foreground">
   <summary className="cursor-pointer">{t("profileProbe.details")}</summary>
   <p className="mt-1">{reason}</p>
  </details>}
 </section>;
}
