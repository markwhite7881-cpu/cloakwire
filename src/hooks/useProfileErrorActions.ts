import {useEffect,useRef,useState} from "react";
import {useI18n} from "@/lib/i18n";
import {findSourceIndex,singleAction,subscriptionForSource,type ProfileSource} from "@/lib/profileEvidence";
export function useProfileErrorActions(options:{
 contextKey:string;ownerContextKey?:string;target:ProfileSource|null;sources:readonly(ProfileSource|null)[];disabled:boolean;
 reconnect:(index:number,target:ProfileSource)=>Promise<void>;
 refresh:(id:string)=>Promise<boolean>;choose:()=>void;
}){
 const current=useRef(options);current.current=options;
 const run=useRef(singleAction());const [busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);const{t}=useI18n();
 const target=options.target,contextKey=options.ownerContextKey??options.contextKey;
 const sourceKey=JSON.stringify(target);
 useEffect(()=>setMessage(null),[sourceKey,contextKey,options.contextKey,options.disabled]);

 const action=(kind:"reconnect"|"refresh")=>void run.current(async()=>{
  const latest=current.current;if(!target||latest.disabled)return;
  const index=findSourceIndex(latest.sources,target);
  if(index<0||contextKey!==latest.contextKey){setMessage(t("profileEvidence.changed"));latest.choose();return}
  setBusy(true);setMessage(null);
  try{
   if(kind==="reconnect")await latest.reconnect(index,target);
   else{const id=subscriptionForSource(target);if(id)setMessage(t(await latest.refresh(id)?"profileEvidence.refreshed":"profileEvidence.refreshFailed"))}
  }catch{setMessage(t("profileEvidence.changed"))}
  finally{setBusy(false)}
 });
 return{busy:busy||options.disabled,message,
  onReconnect:target?()=>action("reconnect"):undefined,
  onRefresh:target&&subscriptionForSource(target)?()=>action("refresh"):undefined};
}
