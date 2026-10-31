import { useCallback, useEffect, useRef, useState } from "react";
import { applyProfileImport, planProfileImport, type ImportDecisions, type ImportPlan } from "@/lib/profileImport";
import type { ManualProfileRecord } from "@/lib/manualProfileStore";
import type { Outbound } from "@/lib/types";
type ImportStore={records:ManualProfileRecord[];saveRecords:(records:ManualProfileRecord[])=>boolean;blocked:boolean;state:{status:string}};
export function useProfileImport(store:ImportStore,onChanged:()=>void) {
  const [plan,setPlan]=useState<ImportPlan|null>(null);
  const [error,setError]=useState<string|null>(null);
  const current=useRef({store,onChanged});current.current={store,onChanged};
  const pending=useRef<((saved:boolean)=>void)|null>(null);
  const commit=useCallback((plan:ImportPlan,decisions:ImportDecisions):boolean=>{
    const {store,onChanged}=current.current;
    const result=applyProfileImport(plan,decisions,store.records);
    if(result.status!=="applied"){setError("profileImport."+result.status);return false;}
    if((store.blocked&&store.state.status!=="write_failed")||!store.saveRecords(result.records)){setError("profileStorage.write_failed");return false;}
    if(result.changedIds.length)onChanged();
    return true;
  },[]);
  const request=useCallback((outbounds:Outbound[]):Promise<boolean>=>{
    if(pending.current||current.current.store.blocked)return Promise.resolve(false);
    const planned=planProfileImport(current.current.store.records,outbounds);
    if(!planned.items.some(item=>item.candidates.length))return Promise.resolve(commit(planned,{}));
    setError(null);setPlan(planned);
    return new Promise(resolve=>{pending.current=resolve;});
  },[commit]);
  const close=useCallback((saved:boolean)=>{
    const resolve=pending.current;pending.current=null;setPlan(null);setError(null);resolve?.(saved);
  },[]);
  const apply=useCallback((decisions:ImportDecisions)=>{
    if(plan&&commit(plan,decisions))close(true);
  },[plan,commit,close]);
  useEffect(()=>()=>{pending.current?.(false);pending.current=null;},[]);
  const cancel=useCallback(()=>close(false),[close]);
  return {plan,error,request,apply,cancel};
}
