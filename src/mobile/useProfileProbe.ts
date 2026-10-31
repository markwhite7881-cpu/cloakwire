import {ProbeResultGate} from "@/lib/probeResultGate";
import {useEffect,useRef,useState} from "react";
import {api} from "@/lib/api";
import {vpnProbe,vpnCancelProbe,vpnProbeSnapshot,onVpnProbe} from "@/lib/vpn";
import {sameSource,type ProfileSource,type ProfileEvidence} from "@/lib/profileEvidence";
import type {ConnectionHealth,HealthSnapshot} from "@/lib/connectionHealth";
import type {GeneratorSettings,Outbound} from "@/lib/types";

export function probeEvidence(health:ConnectionHealth|null):ProfileEvidence|null {
 if(!health||health.scope!=="selected_profile"||health.outcome==="cancelled"||health.outcome==="unknown")return null;
 return {source:{profile_ref:health.profile_ref,source_revision:health.profile_revision},scope:"selected_profile",kind:"access",
 outcome:health.outcome==="healthy"?"passed":health.outcome==="failed"?"failed":health.outcome==="checking"?"checking":"unavailable",
 checked_at:health.outcome==="checking"?Date.now():Date.parse(health.checked_at??""),latency_ms:health.latency_ms};
}
export function useProfileProbe(source:ProfileSource|null,outbound:Outbound|null,settings:GeneratorSettings){
 const [health,setHealth]=useState<ConnectionHealth|null>(null);
 const [preparing,setPreparing]=useState(false);
 const [error,setError]=useState(false);
 const sourceRef=useRef(source);sourceRef.current=source;
 const healthRef=useRef(health);healthRef.current=health;
 const key=JSON.stringify([source,settings]);
 const keyRef=useRef(key);keyRef.current=key;
 const gate=useRef(new ProbeResultGate(key));
 const retired=useRef<string|null>(null);
 const retiredId=gate.current.inputs(key);if(retiredId)retired.current=retiredId;
 const pending=useRef(false);
 const requestEpoch=useRef(0);
 const requestId=useRef<string|null>(null);
 const inTauri=typeof window!=="undefined"&&"__TAURI_INTERNALS__" in window;
 useEffect(()=>{
  if(!inTauri)return;
  let disposed=false,events=0,listener:{unregister:()=>Promise<void>}|null=null;
  const apply=(snapshot:HealthSnapshot,restore=false)=>{
   if(disposed)return;
   events++;
   // A native snapshot can belong to another selection or arrive before source hydration.
   if(restore&&!sameSource(sourceRef.current,probeEvidence(snapshot.selected_profile)?.source))return;
   setHealth(gate.current.accept(snapshot.selected_profile,restore));
  };
  void (async()=>{
   listener=await onVpnProbe(apply);
   if(disposed){await listener.unregister();return}
   const before=events;const snapshot=await vpnProbeSnapshot();
   if(events===before)apply(snapshot,true);
  })().catch(()=>{/* Background snapshot availability must not interrupt the user. */});
  return()=>{disposed=true;void listener?.unregister()};
 },[inTauri]);
 const previousKey=useRef(key);
 useEffect(()=>{
  if(previousKey.current!==key){
   previousKey.current=key;setError(false);
   const id=retired.current??healthRef.current?.operation_id;retired.current=null;
   if(id&&inTauri)void vpnCancelProbe(id).catch(()=>{});
   setHealth(null);
  }
 },[key,inTauri]);
 async function check(){
  if(!source||pending.current||!inTauri)return;
  pending.current=true;setPreparing(true);setError(false);
  const expected=key,epoch=++requestEpoch.current;let id:string|undefined;
  try{
   id=(await vpnProbe(source)).operation_id;
   if(epoch!==requestEpoch.current||!gate.current.expect(expected,id)){await vpnCancelProbe(id);return}
   requestId.current=id;
   await api.runAndroidProfileProbe(id,source,outbound,settings);
   if(keyRef.current!==expected||epoch!==requestEpoch.current)await vpnCancelProbe(id);
   const snapshot=await vpnProbeSnapshot();
   if(keyRef.current===expected&&epoch===requestEpoch.current)setHealth(gate.current.accept(snapshot.selected_profile));
  }catch{
   if(keyRef.current===expected&&epoch===requestEpoch.current)setError(true);
   // Preparation errors have a native safe snapshot; no raw error is displayed.
   if(inTauri)void vpnProbeSnapshot().then(snapshot=>{if(keyRef.current===expected&&epoch===requestEpoch.current)setHealth(gate.current.accept(snapshot.selected_profile))}).catch(()=>{});
  }finally{pending.current=false;setPreparing(false)}
 }
 const accepted=gate.current.accept(health);
 const evidence=probeEvidence(accepted);
 const current=evidence&&sameSource(source,evidence.source)?accepted:null;
 const previous=gate.current.previous(source);
 const history=gate.current.results().map(value=>({...probeEvidence(value)!,historical:true}));
 return {health:current??previous,evidence,history,error,busy:preparing||current?.outcome==="checking",
  check,cancel:async()=>{requestEpoch.current++;const id=requestId.current??healthRef.current?.operation_id;if(id)await vpnCancelProbe(id)}};
}
