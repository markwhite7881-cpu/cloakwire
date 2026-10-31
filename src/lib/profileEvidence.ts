import {sameProfileRef,sameSessionIdentity,type ProfileRef,type DesktopHealthSnapshot} from "./connectionHealth";
import type {ConnectionProfile} from "./connectionProfiles";
import type {StatusReport} from "./types";
export interface ProfileSource { profile_ref:ProfileRef; source_revision:string }
export interface ProfileEvidence { source:ProfileSource; kind:"access"|"preflight"; scope?:"selected_profile"|"active_session"; outcome:"passed"|"failed"|"checking"|"unavailable"; checked_at:number; latency_ms?:number|null }
export function sameSource(a:ProfileSource|null|undefined,b:ProfileSource|null|undefined):boolean {
 return !!a&&!!b&&!!a.source_revision&&a.source_revision===b.source_revision&&sameProfileRef(a.profile_ref,b.profile_ref);
}
export function subscriptionForSource(source:ProfileSource):string|null {
 const ref=source.profile_ref;return ref.kind==="subscription"||ref.kind==="ready"?ref.subscription_id:null;
}
export function findSourceIndex(sources:readonly (ProfileSource|null)[],target:ProfileSource):number{return sources.findIndex(source=>sameSource(source,target))}
export function profileRef(profile:ConnectionProfile):ProfileRef|null{
 if(profile.kind==="manual")return profile.id?{kind:"manual",id:profile.id}:null;
 if(profile.kind==="subscription")return{kind:"subscription",...profile.reference};
 return{kind:"ready",subscription_id:profile.subscriptionId,child_key:profile.key};
}
export function sourceForProfile(profile:ConnectionProfile,manualRevision?:string):ProfileSource|null{
 const ref=profileRef(profile),revision=profile.kind==="manual"?manualRevision:profile.source_revision;
 return ref&&revision?{profile_ref:ref,source_revision:revision}:null;
}
export function badgeForProfile(source:ProfileSource|null,evidence:ProfileEvidence|null,now:number){
 if(!source||!evidence||!sameSource(source,evidence.source))return{state:"unknown",time:null,latency:null};
 const age=now-evidence.checked_at;
 if(!Number.isFinite(age)||age<0||age>=60000)return{state:"stale",time:evidence.checked_at,latency:null};
 return{state:evidence.outcome==="passed"?(evidence.kind==="access"?(evidence.scope==="selected_profile"?"profileHealthy":"healthy"):"prepared"):evidence.outcome,time:evidence.checked_at,latency:evidence.latency_ms??null};
}
export function activeEvidence(status:StatusReport,snapshot:DesktopHealthSnapshot|null):ProfileEvidence|null{
 const session=snapshot?.session,health=snapshot?.health;
 if(!session?.source_revision||status.status!=="running"||session.run_id!==status.run_id||!health||health.scope!=="active_session"||!sameSessionIdentity(session,health)||health.outcome==="cancelled")return null;
 return{source:{profile_ref:session.profile_ref,source_revision:session.source_revision},kind:"access",
 outcome:health.outcome==="healthy"?"passed":health.outcome==="failed"?"failed":health.outcome==="checking"?"checking":"unavailable",
 checked_at:health.outcome==="checking"?Date.now():Date.parse(health.checked_at??""),latency_ms:health.latency_ms};
}
/** Synchronous exclusion: two clicks in one render must not send two requests. */
export function singleAction(){let pending=false;return async(action:()=>Promise<void>)=>{if(pending)return;pending=true;try{await action()}finally{pending=false}}}
