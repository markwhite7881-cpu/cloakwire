import {useI18n} from "@/lib/i18n";
import {ProfileHealthBadge} from "@/components/ProfileHealthBadge";
import type {ProfileSource} from "@/lib/profileEvidence";
import type {useProfileProbe} from "../useProfileProbe";

export function ProfileProbeCard({probe,source,disabled}:{probe:ReturnType<typeof useProfileProbe>;source:ProfileSource|null;disabled:boolean}){
 const {t}=useI18n(),health=probe.health;
 const reason=health?.issue?t("health.reasons."+health.issue):probe.error?t("health.reasons.unknown"):null;
 return <section data-testid="profile-probe-card" className="rounded-2xl border border-border bg-card p-4 text-sm">
  <div className="flex flex-wrap items-center justify-between gap-2">
   <h2 className="font-semibold">{t("profileProbe.title")}</h2>
   <button type="button" data-testid="profile-probe-button" disabled={disabled||!source}
    className="min-h-11 rounded-xl border border-border px-3 font-medium disabled:opacity-50"
    onClick={()=>void (probe.busy?probe.cancel():probe.check()).catch(()=>{})}>
    {t(probe.busy?"profileProbe.cancel":"profileProbe.check")}
   </button>
  </div>
  {source?<ProfileHealthBadge profileRef={source.profile_ref} accessOnly/>:<p className="text-muted-foreground">{t("profileProbe.choose")}</p>}
  {reason&&<details className="mt-2 text-muted-foreground">
   <summary className="cursor-pointer">{t("profileProbe.details")}</summary>
   <p className="mt-1">{reason}</p>
  </details>}
 </section>;
}
