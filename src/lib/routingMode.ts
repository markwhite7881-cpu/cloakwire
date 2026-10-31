import type {EngineKind,GeneratorSettings} from "./types";
export type RoutingMode="all"|"include"|"exclude";
export type RoutingPlatform="desktop"|"android";
export type RoutingDrafts=Partial<Record<"include"|"exclude",string[]>>;
export interface RoutingModeSummary {mode:RoutingMode|"custom";hasAdditionalRules:boolean;available:boolean;reason:"xray"|"requires_tun"|null}
export function describeRoutingMode(settings:GeneratorSettings,platform:RoutingPlatform,engine:EngineKind):RoutingModeSummary{
  const r=settings.routing;
  let mode:RoutingMode|"custom";
  if(platform==="android")mode=r.tun_app_mode??"all";
  else if(r.vpn_processes.length&&r.direct_processes.length)mode="custom";
  else if(r.vpn_processes.length&&r.final_outbound==="direct")mode="include";
  else if(!r.vpn_processes.length&&r.final_outbound==="proxy")mode=r.direct_processes.length?"exclude":"all";
  else mode="custom";
  const reason=platform==="desktop"?(engine==="xray"?"xray":!["tun","both"].includes(settings.tunnel_mode)?"requires_tun":null):null;
  return {mode,available:reason===null,reason,hasAdditionalRules:r.rules.some(rule=>rule.enabled)||r.rule_sets.some(rule=>rule.enabled)||(platform==="android"&&!["proxy","auto"].includes(r.final_outbound))};
}
export function planRoutingModeChange(settings:GeneratorSettings,mode:RoutingMode,platform:RoutingPlatform,drafts:RoutingDrafts={},list?:string[]):{
  next:GeneratorSettings|null;drafts:RoutingDrafts;conflicts:("include"|"exclude"|"custom")[];issue:"empty_include"|null;
}{
  const r=settings.routing,nextDrafts:RoutingDrafts=structuredClone(drafts);
  if(platform==="desktop"){
    if(r.vpn_processes.length)nextDrafts.include=[...r.vpn_processes];
    if(r.direct_processes.length)nextDrafts.exclude=[...r.direct_processes];
  }else if(r.tun_app_mode==="include"||r.tun_app_mode==="exclude"){
    nextDrafts[r.tun_app_mode]=[...(r.tun_app_list??[])];
  }
  const chosen=mode==="all"?[]:[...(list??nextDrafts[mode]??[])];
  if(mode!=="all")nextDrafts[mode]=chosen;
  const current=describeRoutingMode(settings,platform,"singbox").mode;
  const conflicts:("include"|"exclude"|"custom")[]=[];
  if(current==="custom")conflicts.push("custom");
  if(platform==="desktop"){
    if(r.vpn_processes.length&&mode!=="include")conflicts.push("include");
    if(r.direct_processes.length&&mode!=="exclude")conflicts.push("exclude");
  }else if((current==="include"||current==="exclude")&&current!==mode&&(r.tun_app_list??[]).length)conflicts.push(current);
  if(mode==="include"&&!chosen.length)return {next:null,drafts:nextDrafts,conflicts,issue:"empty_include"};
  const routing=platform==="android"?{...r,tun_app_mode:mode,tun_app_list:chosen}:{...r,vpn_processes:mode==="include"?chosen:[],direct_processes:mode==="exclude"?chosen:[],final_outbound:mode==="include"?"direct":"proxy"};
  return {next:{...settings,routing},drafts:nextDrafts,conflicts,issue:null};
}
export function readRoutingDrafts(platform:RoutingPlatform):RoutingDrafts{
  try{
    const value=JSON.parse(localStorage.getItem("cloakwire.routing-drafts."+platform)??"{}");
    return Object.fromEntries(["include","exclude"].flatMap(key=>Array.isArray(value?.[key])&&value[key].every((v:unknown)=>typeof v==="string")?[[key,value[key]]]:[]));
  }catch{return {};}
}
export function saveRoutingDrafts(platform:RoutingPlatform,drafts:RoutingDrafts):boolean{
  try{localStorage.setItem("cloakwire.routing-drafts."+platform,JSON.stringify(drafts));return true;}catch{return false;}
}
