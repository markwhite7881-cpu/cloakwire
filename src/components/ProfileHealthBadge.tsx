import {createContext,useContext,useEffect,useState} from "react";
import {useI18n} from "@/lib/i18n";
import {sameProfileRef,type ProfileRef} from "@/lib/connectionHealth";
import {badgeForProfile,sameSource,type ProfileSource,type ProfileEvidence} from "@/lib/profileEvidence";
export const ProfileHealthContext=createContext<{sources:readonly(ProfileSource|null)[];evidence:ProfileEvidence|null;attempt?:ProfileEvidence|null}>({sources:[],evidence:null});
export function ProfileHealthBadge({profileRef,profileIndex}:{profileRef?:ProfileRef|null;profileIndex?:number}){
 const {sources,evidence,attempt}=useContext(ProfileHealthContext),{t,locale}=useI18n();
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer)},[]);
 const source=profileRef?sources.find(s=>s&&sameProfileRef(s.profile_ref,profileRef))??null:profileIndex!=null?sources[profileIndex]??null:null;
 const badge=badgeForProfile(source,attempt&&sameSource(source,attempt.source)?attempt:evidence,Math.max(now,Date.now()));
 const time=badge.time&&Number.isFinite(badge.time)?new Intl.DateTimeFormat(locale,{hour:"2-digit",minute:"2-digit"}).format(new Date(badge.time)):null;
 return <span data-testid="profile-health" className={"mt-1 block whitespace-normal text-xs leading-snug "+(badge.state==="healthy"?"text-emerald-500":badge.state==="failed"?"text-amber-500":"text-muted-foreground")}>
  {t("profileEvidence."+badge.state)}{time?" · "+time:""}{badge.state==="healthy"&&badge.latency!=null?" · "+badge.latency+" ms":""}
 </span>;
}
