import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { defaultImportDecision, type ImportPlan, type ImportDecision, type ImportDecisions } from "@/lib/profileImport";
import type { ManualProfileRecord } from "@/lib/manualProfileStore";
import { Sheet } from "@/mobile/components/Sheet";
import { Button } from "./Button";
export function ProfileImportContent({plan,records,decisions,onDecision}:{
  plan:ImportPlan;records:ManualProfileRecord[];decisions:ImportDecisions;onDecision:(index:number,decision:ImportDecision)=>void;
}){
  const {t}=useI18n();
  return <div className="space-y-4">{plan.items.map((item,index)=>{
    const selected=decisions[index]??defaultImportDecision(item);
    const label=item.incoming.protocol==="unsupported"?t("profileImport.unsupported"):item.incoming.tag;
    return <fieldset key={index} className="min-w-0 rounded-xl border border-border p-3">
      <legend className="max-w-full break-words px-1 text-sm font-semibold">{label}</legend>
      {item.candidates.map(candidate=>{
        const record=records.find(r=>r.id===candidate.record_id);
        const name=record&&"tag" in record.outbound?record.outbound.tag:t("profileImport.missing");
        return <label key={candidate.record_id} className="flex min-h-11 items-start gap-3 rounded-lg p-2 text-sm">
          <input type="radio" className="mt-1 h-4 w-4 shrink-0" name={"import-"+index}
            checked={selected?.kind==="update"&&selected.record_id===candidate.record_id}
            onChange={()=>onDecision(index,{kind:"update",record_id:candidate.record_id,expected_revision:candidate.expected_revision})}/>
          <span className="min-w-0 break-words"><span className="font-medium">{t("profileImport.update")} — {name}</span>
            <span className="mt-1 block text-muted-foreground">{candidate.exact_duplicate?t("profileImport.duplicate"):candidate.changed_fields.map(field=>t("profileImport.fields."+field)).join(", ")}</span>
          </span>
        </label>;
      })}
      {(["add_separately","skip"] as const).map(kind=><label key={kind} className="flex min-h-11 items-center gap-3 rounded-lg p-2 text-sm">
        <input type="radio" className="h-4 w-4" name={"import-"+index} checked={selected?.kind===kind}
          onChange={()=>onDecision(index,{kind})}/>{t("profileImport."+kind)}
      </label>)}
    </fieldset>;
  })}</div>;
}
export function ProfileImportDialog({plan,records,error,mobile=false,onApply,onCancel}:{
  plan:ImportPlan|null;records:ManualProfileRecord[];error:string|null;mobile?:boolean;
  onApply:(decisions:ImportDecisions)=>void;onCancel:()=>void;
}){
  const {t}=useI18n(),[decisions,setDecisions]=useState<ImportDecisions>({});
  const body=useRef<HTMLDivElement>(null);
  useEffect(()=>{setDecisions({});},[plan]);
  useEffect(()=>{
    if(!plan)return;
    const previous=document.activeElement as HTMLElement|null;
    const modal=body.current?.closest('[role="dialog"]') as HTMLElement|null;
    const elements=()=>Array.from(modal?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')??[]);
    elements()[0]?.focus();
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onCancel();}
      if(event.key!=="Tab")return;
      const all=elements(),first=all[0],last=all[all.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown",onKey);
    return ()=>{document.removeEventListener("keydown",onKey);previous?.focus();};
  },[plan,onCancel]);
  if(!plan)return null;
  const content=<div ref={body} className="space-y-4">
    <p className="text-sm leading-relaxed text-muted-foreground">{t("profileImport.description")}</p>
    <ProfileImportContent plan={plan} records={records} decisions={decisions} onDecision={(i,d)=>setDecisions(prev=>({...prev,[i]:d}))}/>
    {error&&<p role="alert" className="text-sm text-destructive">{t(error)}</p>}
    <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 bg-card py-2">
      <Button variant="outline" className="min-h-11" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button className="min-h-11" onClick={()=>onApply(decisions)}>{t("profileImport.apply")}</Button>
    </div>
  </div>;
  if(mobile)return <Sheet open onClose={onCancel} title={t("profileImport.title")}>{content}</Sheet>;
  return <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
    <section role="dialog" aria-modal="true" aria-labelledby="profile-import-title" className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl">
      <h2 id="profile-import-title" className="mb-3 text-lg font-semibold">{t("profileImport.title")}</h2>{content}
    </section>
  </div>;
}
