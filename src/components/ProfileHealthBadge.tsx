import {createContext,useContext,useEffect,useState} from "react";
import {useI18n} from "@/lib/i18n";
import {sameProfileRef,type ProfileRef} from "@/lib/connectionHealth";
import {badgeForProfile,sameSource,type ProfileSource,type ProfileEvidence} from "@/lib/profileEvidence";
export const ProfileHealthContext=createContext<{sources:readonly(ProfileSource|null)[];evidence:ProfileEvidence|null;attempt?:ProfileEvidence|null;history?:readonly ProfileEvidence[]}>({sources:[],evidence:null});
export function ProfileHealthBadge({profileRef,profileIndex,accessOnly=false}:{profileRef?:ProfileRef|null;profileIndex?:number;accessOnly?:boolean}){
 const {sources,evidence,attempt,history}=useContext(ProfileHealthContext),{t,locale}=useI18n();
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer)},[]);
 const source=profileRef?sources.find(s=>s&&sameProfileRef(s.profile_ref,profileRef))??null:profileIndex!=null?sources[profileIndex]??null:null;
 const previous=history?.slice().reverse().find(item=>sameSource(source,item.source));
 const chosen=[attempt,previous,evidence].filter((item):item is ProfileEvidence=>!!item && sameSource(source,item.source) && (!accessOnly || item.kind==="access")).sort((a,b)=>b.checked_at-a.checked_at)[0] ?? null;
 const badge=badgeForProfile(source,accessOnly&&chosen?.kind!=="access"?null:chosen,Math.max(now,Date.now()));
 if(badge.state==="unknown")return null;
 const time=badge.time&&Number.isFinite(badge.time)?new Intl.DateTimeFormat(locale,{hour:"2-digit",minute:"2-digit"}).format(new Date(badge.time)):null;
 return <span data-testid="profile-health" className={"mt-1 block whitespace-normal text-xs leading-snug "+((badge.state==="healthy"||badge.state==="profileHealthy")?"text-emerald-500":badge.state==="failed"?"text-amber-500":"text-muted-foreground")}>
  {t("profileEvidence."+badge.state)}{time?" · "+time:""}{(badge.state==="healthy"||badge.state==="profileHealthy"||badge.state==="pastPassed")&&badge.latency!=null?" · "+badge.latency+" ms":""}
 </span>;
}
