import type { Outbound } from "./types";
import { canonicalProfile, newManualRecord, replaceManualRecord, type ManualProfileRecord } from "./manualProfileStore";
export type ChangedField = "user" | "key" | "endpoint" | "transport" | "tls" | "other";
export interface ImportCandidate { record_id:string; expected_revision:number; changed_fields:ChangedField[]; exact_duplicate:boolean }
export interface ImportPlan { items: { incoming:Outbound; candidates:ImportCandidate[] }[] }
export type ImportDecision = {kind:"update";record_id:string;expected_revision:number} | {kind:"add_separately"|"skip"};
export type ImportDecisions = Record<number,ImportDecision>;
export type ImportApplyResult = {status:"applied";records:ManualProfileRecord[];changedIds:string[]} | {status:"needs_choice"|"stale"|"conflict"};
function payload(outbound:Outbound): string {
  if(outbound.protocol==="unsupported")return canonicalProfile(outbound);
  const {tag:_tag,...rest}=outbound; return canonicalProfile(rest);
}
function endpoint(outbound:Outbound): string|null {
  if(outbound.protocol==="unsupported")return null;
  const host=outbound.server.trim().toLowerCase().replace(/^\[|\]$/g,"").replace(/\.$/,"");
  return JSON.stringify([outbound.protocol,host,outbound.port]);
}
function changedFields(before:Outbound,after:Outbound):ChangedField[] {
  const a=before as unknown as Record<string,unknown>,b=after as unknown as Record<string,unknown>;
  const fields=new Set<ChangedField>();
  for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
    if(key==="tag"||canonicalProfile(a[key])===canonicalProfile(b[key]))continue;
    if(["uuid","password","alter_id"].includes(key))fields.add("user");
    else if(["server","port","protocol"].includes(key))fields.add("endpoint");
    else if(["transport","flow","plugin","plugin_opts"].includes(key))fields.add("transport");
    else if(key==="tls"){
      const ta=(a.tls??{}) as Record<string,unknown>,tb=(b.tls??{}) as Record<string,unknown>;
      if(canonicalProfile(ta.reality)!==canonicalProfile(tb.reality)||canonicalProfile(ta.ech)!==canonicalProfile(tb.ech))fields.add("key");
      const {reality:_ar,ech:_ae,...ra}=ta,{reality:_br,ech:_be,...rb}=tb;
      if(canonicalProfile(ra)!==canonicalProfile(rb))fields.add("tls");
    }else fields.add("other");
  }
  return [...fields];
}
export function planProfileImport(existing:ManualProfileRecord[],incoming:Outbound[]):ImportPlan {
  return {items:incoming.map(outbound=>({incoming:structuredClone(outbound),candidates:existing
    .filter(r=>endpoint(outbound)!==null&&endpoint(r.outbound)===endpoint(outbound))
    .map(r=>({record_id:r.id,expected_revision:r.revision,changed_fields:changedFields(r.outbound,outbound),exact_duplicate:payload(r.outbound)===payload(outbound)}))}))};
}
export function defaultImportDecision(item:ImportPlan["items"][number]):ImportDecision|undefined {
  if(item.candidates.some(c=>c.exact_duplicate))return {kind:"skip"};
  if(!item.candidates.length)return {kind:"add_separately"};
}
export function applyProfileImport(plan:ImportPlan,decisions:ImportDecisions,current:ManualProfileRecord[]):ImportApplyResult {
  const next=current.slice(),changedIds:string[]=[];
  const updated=new Set<string>(),seen=new Set<string>();
  const tags=new Set(["proxy","auto","direct","block","dns-out",...current.flatMap(r=>"tag" in r.outbound?[r.outbound.tag]:[])]);
  for(const [index,item] of plan.items.entries()){
    const decision=decisions[index]??defaultImportDecision(item);
    if(!decision)return {status:"needs_choice"};
    if(decision.kind==="skip")continue;
    if(decision.kind==="update"){
      const candidate=item.candidates.find(c=>c.record_id===decision.record_id&&c.expected_revision===decision.expected_revision);
      const position=next.findIndex(r=>r.id===decision.record_id);
      if(!candidate||position<0||current.find(r=>r.id===decision.record_id)?.revision!==decision.expected_revision)return {status:"stale"};
      if(updated.has(decision.record_id))return {status:"conflict"};
      updated.add(decision.record_id);
      const old=next[position];
      if(old.outbound.protocol==="unsupported"||item.incoming.protocol==="unsupported")return {status:"stale"};
      next[position]=replaceManualRecord(old,{...item.incoming,tag:old.outbound.tag});
      if(next[position].revision!==old.revision)changedIds.push(old.id);
      continue;
    }
    const serialized=payload(item.incoming);
    // Explicit add allows an existing duplicate; repeated rows in one batch still coalesce.
    if(seen.has(serialized))continue; seen.add(serialized);
    let outbound=structuredClone(item.incoming);
    if(outbound.protocol!=="unsupported"){
      const base=outbound.tag||"Server";let name=base,n=2;
      while(tags.has(name))name=base+" ("+(n++)+")";
      outbound={...outbound,tag:name};tags.add(name);
    }
    const record=newManualRecord(outbound);next.push(record);changedIds.push(record.id);
  }
  return {status:"applied",records:next,changedIds};
}
