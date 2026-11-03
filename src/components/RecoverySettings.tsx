import { AtlasSwitch } from "@/components/atlas/AtlasSwitch";
import {createContext,useContext,useEffect,useState,useSyncExternalStore,type ReactNode} from "react";
import {invoke} from "@tauri-apps/api/core";
import {RecoverySettings,type RecoveryPreferenceState} from "@/lib/recoverySettings";
import {useI18n} from "@/lib/i18n";

interface RecoveryStatus {
 enabled:boolean;
 phase:"idle"|"waiting"|"checking"|"recovering"|"unavailable"|"exhausted";
 attempts:number;
 issue?:string|null;
 run_id?:string|null;
}
const fallback:RecoveryPreferenceState={enabled:false,busy:true,issue:null};
const Context=createContext({preference:fallback,status:null as RecoveryStatus|null,setEnabled:async(_enabled:boolean)=>{}});
export function RecoverySettingsProvider({mobile,children}:{mobile:boolean;children:ReactNode}){
 const [controller]=useState(()=>new RecoverySettings({
  getItem:key=>window.localStorage.getItem(key),
  setItem:(key,value)=>window.localStorage.setItem(key,value),
  removeItem:key=>window.localStorage.removeItem(key),
 },async enabled=>{
  if(!("__TAURI_INTERNALS__" in window))return;
  await invoke(mobile?"plugin:vpn|setRecoveryEnabled":"set_recovery_enabled",{enabled});
 }));
 const preference=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
 const [status,setStatus]=useState<RecoveryStatus|null>(null);
 useEffect(()=>{void controller.initialize();},[controller]);
 useEffect(()=>{
  if(!preference.enabled||!("__TAURI_INTERNALS__" in window)){setStatus(null);return;}
  let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const read=async()=>{
   try{
    const result=await invoke<RecoveryStatus|null>(mobile?"plugin:vpn|recoveryStatus":"get_recovery_status");
    if(!disposed)setStatus(result??null);
   }catch{if(!disposed)setStatus(null);}
   finally{if(!disposed)timer=setTimeout(read,1000);}
  };
  void read();
  return ()=>{disposed=true;if(timer)clearTimeout(timer);};
 },[mobile,preference.enabled]);
 return <Context.Provider value={{preference,status,setEnabled:enabled=>controller.setEnabled(enabled)}}>{children}</Context.Provider>;
}
/** One control in each shell; changing it never regenerates a VPN profile. */
export function RecoverySetting(){
 const {t}=useI18n(),{preference,status,setEnabled}=useContext(Context);
 return <div className="atlas-recovery" data-testid="recovery-setting">
  <label className="atlas-setting-row atlas-recovery-row">
   <span className="min-w-0">
    <span className="block text-sm font-medium">{t("recovery.title")}</span>
    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t("recovery.hint")}</span>
   </span>
   <AtlasSwitch label={t("recovery.title")} checked={preference.enabled} disabled={preference.busy}
     onChange={enabled=>void setEnabled(enabled)} />
  </label>
  {preference.enabled&&status?.enabled&&status.phase==="unavailable"&&status.issue==="unsupported_probe"&&<p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("recovery.unsupported")}</p>}
  {preference.issue&&<p role="alert" className="mt-2 text-xs text-destructive">{t("recovery."+preference.issue+"Failed")}</p>}
 </div>;
}
/** Polls above only read native state. No React retry timers or diagnostic requests. */
export function RecoveryNotice(){
 const {t}=useI18n(),{preference,status}=useContext(Context);
 if(!preference.enabled||!status?.enabled)return null;
 const terminal=status.phase==="unavailable"||status.phase==="exhausted";
 const message=terminal&&status.issue==="permission_required"?"permission":
  terminal&&status.issue==="authentication"?"authentication":
  status.phase==="recovering"?"recovering":status.phase==="exhausted"?"exhausted":null;
 if(!message)return null;
 return <p role="status" className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground" data-testid="recovery-notice">{t("recovery."+message)}</p>;
}
