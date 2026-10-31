import { isHealthFresh,sameSessionIdentity,type AcceptedSession,type ConnectionHealth,type DesktopHealthSnapshot,type RuntimeIssue } from "./connectionHealth";
import type {StatusReport} from "./types";
export type ConnectionPresentationState="stopped"|"starting"|"stopping"|"running"|"checking"|"healthy"|"degraded"|"unavailable"|"crashed";
export interface ConnectionPresentation {
  state:ConnectionPresentationState;session:AcceptedSession|null;health:ConnectionHealth|null;
  issue:RuntimeIssue|null;canRetry:boolean;
}
/** Only a native snapshot of the same accepted run may describe its health.
 * A currently selected row is deliberately not an input. */
export function presentConnection(status:StatusReport,snapshot:DesktopHealthSnapshot|null,now:number):ConnectionPresentation{
  const session=status.run_id&&snapshot?.session?.run_id===status.run_id?snapshot.session:null;
  const running=status.status==="running";
  let state:ConnectionPresentationState=running?"running":status.status==="crashed"?"crashed":status.status;
  let health:ConnectionHealth|null=null;
  let issue:RuntimeIssue|null=null;
  if(session&&snapshot){
    const candidate=snapshot.health;
    if(running&&candidate?.scope==="active_session"&&sameSessionIdentity(candidate,session)){
      if(candidate.outcome==="checking"){health=candidate;state="checking";}
      else if(isHealthFresh(candidate,session,now)){
        health=candidate;
        state=candidate.outcome==="healthy"?"healthy":candidate.outcome==="failed"?"degraded":"unavailable";
      }
    }
    const evidence=snapshot.issue;
    const age=evidence?now-Date.parse(evidence.observed_at):Infinity;
    if(evidence?.run_id===session.run_id&&age>=0&&age<60000&&(running||snapshot.ended_unexpectedly)){
      issue=evidence;
    }
    if(!running&&snapshot.ended_unexpectedly&&issue?.severity==="connection")state="crashed";
  }
  return{state,session,health,issue,canRetry:running&&!!session};
}
