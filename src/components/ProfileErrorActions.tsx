import {RefreshCw,Power} from "lucide-react";
import {useI18n} from "@/lib/i18n";
export interface ProfileErrorActionsProps{onReconnect?:()=>void;onRefresh?:()=>void;busy?:boolean;message?:string|null}
export function ProfileErrorActions({onReconnect,onRefresh,busy,message}:ProfileErrorActionsProps){
 const {t}=useI18n();
 if(!onReconnect&&!onRefresh&&!message)return null;
 return <div className="flex flex-wrap items-center gap-2" data-testid="profile-error-actions">
 {onRefresh&&<button type="button" disabled={busy} onClick={onRefresh} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"><RefreshCw aria-hidden="true" className="h-4 w-4 shrink-0"/>{t("profileEvidence.refresh")}</button>}
 {onReconnect&&<button type="button" disabled={busy} onClick={onReconnect} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"><Power aria-hidden="true" className="h-4 w-4 shrink-0"/>{t("profileEvidence.reconnect")}</button>}
 {message&&<p role="status" className="w-full text-xs text-muted-foreground">{message}</p>}
 </div>;
}
