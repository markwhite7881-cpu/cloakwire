import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {ConnectionStatus} from "./ConnectionStatus";
import {presentConnection} from "@/lib/connectionPresentation";
import type {StatusReport} from "@/lib/types";
const status:StatusReport={status:"running",run_id:"7",pid:7,uptime_secs:1,last_exit_code:null,last_error:null};
it("shows a running process without claiming verified access",()=>{
  const html=renderToStaticMarkup(<ConnectionStatus view={presentConnection(status,null,0)}/>);
  expect(html).toContain("VPN is running");expect(html).not.toContain("Server connection verified");
});
it("renders a safe runtime cause and retry action without credential or refresh UI",()=>{
  const session={profile_ref:{kind:"manual" as const,id:"a"},profile_revision:"r",run_id:"7",network_generation:"n",effective_outbound_revision:"e",engine:"singbox" as const,display_name:"Server A"};
  const html=renderToStaticMarkup(<ConnectionStatus view={presentConnection(status,{session,health:null,ended_unexpectedly:false,issue:{run_id:"7",code:"reality_verification",severity:"notice",count:2,observed_at:new Date(0).toISOString()}},0)} onRetry={()=>{}}/>);
  expect(html).toContain("Reality");expect(html).toContain("Check again");expect(html).not.toContain("Refresh subscription");expect(html).not.toContain("UUID");
});
