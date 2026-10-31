import type {ReactNode} from "react";
import {AlertCircle,CheckCircle2,RefreshCw,Server} from "lucide-react";
import {useI18n} from "@/lib/i18n";
import type {ConnectionPresentation} from "@/lib/connectionPresentation";
export function ConnectionStatus({view,onRetry,onChooseServer,busy=false,message,showHeading=true,actions}:{
  view:ConnectionPresentation;onRetry?:()=>void;onChooseServer?:()=>void;busy?:boolean;message?:string|null;showHeading?:boolean;actions?:ReactNode;
}){
  const {t,locale}=useI18n();
  const code=view.issue?.code??view.health?.issue;
  const time=view.health?.checked_at&&Number.isFinite(Date.parse(view.health.checked_at))
    ?new Intl.DateTimeFormat(locale,{hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date(view.health.checked_at)):null;
  const needsAttention=!!code||view.state==="degraded"||view.state==="crashed";
  if(view.state==="stopped"&&!view.issue)return null;
  return <section aria-label={t("health.title")} data-testid="connection-health" className="mt-3 min-w-0 space-y-2 rounded-xl border border-border/60 bg-background/40 p-3 text-left text-sm">
    {showHeading&&<p role="status" className="flex items-center gap-2 font-medium">
      {view.state==="healthy"?<CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-500"/>:needsAttention?<AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-500"/>:null}
      {t(`health.${view.state}`)}
    </p>}
    {view.session?.display_name&&<p className="break-words text-muted-foreground">{t("health.session",{name:view.session.display_name==="auto"?t("health.auto"):view.session.display_name})}</p>}
    {view.issue&&<p className="font-medium">{t(view.issue.severity==="notice"?"health.notice":"health.stoppedReason")}{view.issue.count>1? ` · ${view.issue.count}`:""}</p>}
    {code&&<p role={view.issue?"alert":undefined} className="break-words text-foreground/90">{t(`health.reasons.${code}`)}</p>}
    {time&&<p className="text-xs text-muted-foreground">{t("health.checked",{time})}{view.state==="healthy"&&view.health?.latency_ms!=null?` · ${view.health.latency_ms} ms`:""}</p>}
    {view.canRetry&&onRetry&&<button type="button" onClick={onRetry} disabled={busy||view.state==="checking"} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-muted disabled:opacity-50">
      <RefreshCw aria-hidden="true" className={`h-4 w-4 ${busy||view.state==="checking"?"animate-spin motion-reduce:animate-none":""}`}/>
      {t(view.state==="checking"?"health.checking":"health.retry")}
    </button>}
    {needsAttention&&onChooseServer&&<button type="button" onClick={onChooseServer} className="ml-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
      <Server aria-hidden="true" className="h-4 w-4"/>{t("health.choose")}
    </button>}
    {needsAttention&&actions}
    {message&&<p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </section>;
}
