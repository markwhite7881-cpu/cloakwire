import {useState} from "react";
import {canonicalProfile} from "@/lib/manualProfileStore";
import {describeRoutingMode,planRoutingModeChange,readRoutingDrafts,saveRoutingDrafts,type RoutingMode,type RoutingPlatform} from "@/lib/routingMode";
import type {GeneratorSettings} from "@/lib/types";
export function useRoutingModeDraft(settings:GeneratorSettings,platform:RoutingPlatform,onChange:(next:GeneratorSettings)=>void){
  const [drafts,setDrafts]=useState(()=>readRoutingDrafts(platform));
  const [pending,setPending]=useState<{mode:RoutingMode;list:string[];base:string}|null>(null);
  const [error,setError]=useState<string|null>(null);
  const current=describeRoutingMode(settings,platform,"singbox").mode;
  const actualList=platform==="android"?(settings.routing.tun_app_list??[]):current==="include"?settings.routing.vpn_processes:current==="exclude"?settings.routing.direct_processes:[];
  const choose=(mode:RoutingMode)=>{
    const planned=planRoutingModeChange(settings,mode,platform,drafts);
    setPending({mode,list:mode==="all"?[]:planned.drafts[mode]??[],base:canonicalProfile(settings.routing)});setError(null);
  };
  const changeList=(list:string[])=>{
    const mode=pending?.mode??(current==="custom"?"include":current);
    setPending({mode,list,base:pending?.base??canonicalProfile(settings.routing)});setError(null);
  };
  const planned=pending?planRoutingModeChange(settings,pending.mode,platform,drafts,pending.list):null;
  const apply=()=>{
    if(!pending||!planned)return;
    if(pending.base!==canonicalProfile(settings.routing)){setError("routingModes.stale");return;}
    if(!planned.next){setError("routingModes."+planned.issue);return;}
    if(!saveRoutingDrafts(platform,planned.drafts)){setError("routingModes.save_failed");return;}
    setDrafts(planned.drafts);onChange(planned.next);setPending(null);setError(null);
  };
  return {pending,mode:pending?.mode??(current==="custom"?"all":current),list:pending?.list??actualList,choose,changeList,planned,apply,cancel:()=>{setPending(null);setError(null);},error};
}
