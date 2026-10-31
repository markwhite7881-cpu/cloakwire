import {useI18n} from "@/lib/i18n";
import {describeRoutingMode} from "@/lib/routingMode";
import {useRoutingModeDraft} from "@/hooks/useRoutingModeDraft";
import type {EngineKind,GeneratorSettings} from "@/lib/types";
import {ProcessPicker} from "./ProcessPicker";
import {Button} from "../Button";
export function RoutingModePanel({settings,engine,onChange}:{settings:GeneratorSettings;engine:EngineKind;onChange:(next:GeneratorSettings)=>void}){
  const {t}=useI18n(),summary=describeRoutingMode(settings,"desktop",engine);
  const draft=useRoutingModeDraft(settings,"desktop",onChange);
  return <section className="rounded-2xl border border-border bg-card p-5 space-y-4" aria-label={t("routingModes.title")}>
    <div><h3 className="text-sm font-semibold">{t("routingModes.title")}: {t("routingModes."+summary.mode)}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("routingModes.scope")}</p>
      {summary.hasAdditionalRules&&<p className="mt-2 text-sm text-muted-foreground">{t("routingModes.additional")}</p>}
      {summary.reason&&<p role="status" className="mt-2 text-sm text-amber-600 dark:text-amber-300">{t("routingModes."+summary.reason)}</p>}
    </div>
    <div className="grid gap-2 sm:grid-cols-3">{(["all","include","exclude"] as const).map(mode=><Button key={mode} className="min-h-11 h-auto whitespace-normal" variant={(draft.pending?draft.mode:summary.mode)===mode?"default":"outline"} aria-pressed={(draft.pending?draft.mode:summary.mode)===mode} disabled={!summary.available} onClick={()=>draft.choose(mode)}>{t("routingModes."+mode)}</Button>)}</div>
    {draft.pending&&<>
      <p className="text-sm text-muted-foreground">{t("routingModes.pending")}</p>
      {draft.mode!=="all"&&<div className="space-y-3">
        <div className="flex flex-wrap gap-2">{draft.list.map(name=><Button className="min-h-11 break-all" variant="outline" key={name} aria-label={t("routing.removeApp",{name})} onClick={()=>draft.changeList(draft.list.filter(n=>n!==name))}>{name} ×</Button>)}</div>
        <ProcessPicker selected={draft.list} onChange={draft.changeList} disabled={!summary.available}/>
      </div>}
      {!!draft.planned?.conflicts.length&&<p className="text-sm text-muted-foreground">{t("routingModes.conflict",{modes:draft.planned.conflicts.map(mode=>t("routingModes."+mode)).join(", ")})}</p>}
      {draft.error&&<p role="alert" className="text-sm text-destructive">{t(draft.error)}</p>}
      <div className="flex flex-wrap gap-2"><Button className="min-h-11" disabled={!summary.available} onClick={draft.apply}>{t("routingModes.apply")}</Button><Button className="min-h-11" variant="outline" onClick={draft.cancel}>{t("common.cancel")}</Button></div>
    </>}
  </section>;
}
