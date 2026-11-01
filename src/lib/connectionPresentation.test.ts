import { describe,expect,it } from "vitest";
import { presentConnection } from "./connectionPresentation";
import type { DesktopHealthSnapshot,ConnectionHealth } from "./connectionHealth";
import type { StatusReport } from "./types";
const now=Date.parse("2026-10-31T12:00:00Z");
const status:StatusReport={status:"running",run_id:"7",pid:7,uptime_secs:1,last_exit_code:null,last_error:null};
const session={profile_ref:{kind:"manual" as const,id:"a"},profile_revision:"native-a",run_id:"7",network_generation:"n1",effective_outbound_revision:"member1",engine:"singbox" as const,display_name:"Server A"};
const health:ConnectionHealth={...session,operation_id:"op",scope:"active_session",stage:"complete",outcome:"healthy",issue:null,checked_at:new Date(now).toISOString(),latency_ms:12};
const snapshot:DesktopHealthSnapshot={session,health,issue:null,ended_unexpectedly:false};
describe("accepted desktop session presentation",()=>{
  it("running without a check is not verified",()=>expect(presentConnection(status,null,now).state).toBe("running"));
  it("uses the accepted name even after selection or source removal",()=>{
    const view=presentConnection(status,snapshot,now);expect(view.state).toBe("healthy");expect(view.session?.display_name).toBe("Server A");
  });
  it.each([
    {...health,run_id:"old"}, {...health,profile_revision:"old"}, {...health,network_generation:"old"},
    {...health,effective_outbound_revision:"old"}, {...health,scope:"selected_profile" as const},
    {...health,checked_at:new Date(now-60000).toISOString()}, {...health,checked_at:new Date(now+1).toISOString()},
  ])("rejects stale or separately tested health",candidate=>expect(presentConnection(status,{...snapshot,health:candidate},now).state).toBe("running"));
  it("cancellation is not an error",()=>{
    const view=presentConnection(status,{...snapshot,health:{...health,outcome:"cancelled"}},now);
    expect(view.state).toBe("running");expect(view.health).toBeNull();
  });
  it("old async snapshots cannot replace the newly running profile",()=>{
    const view=presentConnection({...status,run_id:"8"},snapshot,now);expect(view.session).toBeNull();expect(view.canRetry).toBe(false);
  });
  it("an individual runtime notice does not change verified lifecycle",()=>{
    const view=presentConnection(status,{...snapshot,issue:{run_id:"7",code:"reality_verification",severity:"notice",count:2,observed_at:new Date(now).toISOString()}},now);
    expect(view.state).toBe("healthy");expect(view.issue?.severity).toBe("notice");
  });
  it("unexpected exit is scoped to the last accepted run",()=>{
    const ended={...snapshot,health:null,ended_unexpectedly:true,issue:{run_id:"7",code:"engine_unavailable" as const,severity:"connection" as const,count:1,observed_at:new Date(now).toISOString()}};
    expect(presentConnection({...status,status:"stopped"},ended,now).state).toBe("crashed");
    expect(presentConnection({...status,status:"stopped",run_id:"8"},ended,now).state).toBe("stopped");
  });
  it("stopped sessions never retain a green badge",()=>expect(presentConnection({...status,status:"stopped"},snapshot,now).state).toBe("stopped"));
});

it("retains the dated last result without claiming it is a fresh check",()=>{const view=presentConnection(status,snapshot,now+3600000);expect(view.state).toBe("running");expect(view.health?.checked_at).toBe(health.checked_at);expect(view.health?.latency_ms).toBe(12);});
