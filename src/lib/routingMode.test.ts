import {describe,it,expect} from "vitest";
import {describeRoutingMode,planRoutingModeChange} from "./routingMode";
import {DEFAULT_SETTINGS} from "./defaults";
const settings=()=>structuredClone(DEFAULT_SETTINGS);
describe("explicit routing mode changes",()=>{
  it("opening and describing legacy custom routing never mutates it",()=>{
    const s=settings();s.routing.vpn_processes=["one"];s.routing.direct_processes=["one"];s.routing.final_outbound="provider";
    const snapshot=structuredClone(s);
    expect(describeRoutingMode(s,"desktop","singbox").mode).toBe("custom");expect(s).toEqual(snapshot);
  });
  it("maps all/include/exclude over the existing fields and rejects empty include",()=>{
    const s=settings();
    expect(describeRoutingMode(s,"desktop","singbox").mode).toBe("all");
    expect(planRoutingModeChange(s,"include","desktop",{},[]).issue).toBe("empty_include");
    const next=planRoutingModeChange(s,"include","desktop",{},["one"]).next!;
    expect(next.routing).toMatchObject({vpn_processes:["one"],direct_processes:[],final_outbound:"direct"});
    expect(describeRoutingMode(next,"desktop","singbox").mode).toBe("include");
  });
  it("keeps DNS, rule sets and custom rules when switching base policy",()=>{
    const s=settings();s.routing.vpn_processes=["vpn"];s.routing.final_outbound="direct";
    s.routing.rules=[{id:"custom",label:"custom",enabled:true,matchers:{domain:["example.test"]},action:{kind:"route",outbound:"proxy"}}];
    const planned=planRoutingModeChange(s,"exclude","desktop",{},["direct"]);
    expect(planned.conflicts).toContain("include");expect(planned.next!.routing.rules).toEqual(s.routing.rules);
    expect(planned.next!.local_dns).toBe(s.local_dns);expect(planned.next!.routing.rule_sets).toEqual(s.routing.rule_sets);
    expect(planned.next!.routing.vpn_processes).toEqual([]);
    expect(describeRoutingMode(planned.next!,"desktop","singbox").hasAdditionalRules).toBe(true);
  });
  it("inactive lists never execute and returning restores their draft",()=>{
    const s=settings();s.routing.vpn_processes=["one"];s.routing.final_outbound="direct";
    const excluded=planRoutingModeChange(s,"exclude","desktop",{},["two"]);
    const all=planRoutingModeChange(excluded.next!,"all","desktop",excluded.drafts);
    expect(all.next!.routing.vpn_processes).toEqual([]);expect(all.next!.routing.direct_processes).toEqual([]);
    const restored=planRoutingModeChange(all.next!,"include","desktop",all.drafts);
    expect(restored.next!.routing.vpn_processes).toEqual(["one"]);expect(restored.next!.routing.direct_processes).toEqual([]);
  });
  it("Android changes only package capture policy and keeps per-mode drafts",()=>{
    const s=settings();s.routing.tun_app_mode="include";s.routing.tun_app_list=["app.one"];
    s.routing.vpn_processes=["desktop.exe"];s.routing.final_outbound="auto";
    const next=planRoutingModeChange(s,"exclude","android",{},["app.two"]);
    expect(next.next!.routing).toMatchObject({tun_app_mode:"exclude",tun_app_list:["app.two"],vpn_processes:["desktop.exe"],final_outbound:"auto"});
    expect(planRoutingModeChange(next.next!,"include","android",next.drafts).next!.routing.tun_app_list).toEqual(["app.one"]);
  });
  it("desktop Xray cannot claim process capture and a non-TUN mode is unavailable",()=>{
    expect(describeRoutingMode(settings(),"desktop","xray")).toMatchObject({available:false,reason:"xray"});
    const s=settings();s.tunnel_mode="system_proxy";
    expect(describeRoutingMode(s,"desktop","singbox")).toMatchObject({available:false,reason:"requires_tun"});
    expect(describeRoutingMode(settings(),"android","xray").available).toBe(true);
  });
});
