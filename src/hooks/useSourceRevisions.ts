import {useEffect,useState} from "react";
import {api} from "@/lib/api";
import type {Outbound} from "@/lib/types";
/** Never expose the previous array's digests while a new source is loading. */
export function useSourceRevisions(outbounds:Outbound[]){
 const [result,setResult]=useState<{outbounds:Outbound[];revisions:string[]}|null>(null);
 useEffect(()=>{let live=true;
  if("__TAURI_INTERNALS__" in window)void api.profileSourceRevisions(outbounds).then(revisions=>{if(live)setResult(Array.isArray(revisions)&&revisions.length===outbounds.length?{outbounds,revisions}:null)}).catch(()=>{if(live)setResult(null)});
  return()=>{live=false};
 },[outbounds]);
 return result?.outbounds===outbounds?result.revisions:[];
}
