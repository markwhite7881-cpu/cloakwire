import {useI18n} from "@/lib/i18n";
import {ProfileHealthBadge} from "@/components/ProfileHealthBadge";
import type {ProfileSource} from "@/lib/profileEvidence";
import type {useProfileProbe} from "../useProfileProbe";

export function ProfileProbeCard({probe,source,disabled}:{probe:ReturnType<typeof useProfileProbe>;source:ProfileSource|null;disabled:boolean}){
 const {t}=useI18n(),health=probe.health;
 return <section data-testid="profile-probe-card" className="rounded-2xl border border-border bg-card p-4 text-sm">
  <h2 className="font-semibold">{t("profileProbe.title")}</h2>
  <p className="mt-1 text-muted-foreground">{t(source?"profileProbe.hint":"profileProbe.choose")}</p>
  {source&&<ProfileHealthBadge profileRef={source.profile_ref}/>}
  <div role="status" aria-live="polite" className="mt-2">
   {health?.issue?t("health.reasons."+health.issue):probe.error?t("health.reasons.unknown"):null}
  </div>
  <button type="button" data-testid="profile-probe-button" disabled={disabled||!source}
   className="mt-3 min-h-11 w-full rounded-xl border border-border px-4 font-medium disabled:opacity-50"
   onClick={()=>void (probe.busy?probe.cancel():probe.check()).catch(()=>{})}>
   {t(probe.busy?"profileProbe.cancel":"profileProbe.check")}
  </button>
 </section>;
}
