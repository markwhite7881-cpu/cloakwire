import {expect,type Page,type TestInfo} from "playwright/test";
export const v1="singbox-client.manual-profiles.v1",v2="singbox-client.manual-profiles.v2";
export const settingsKey="singbox-client.settings.v2";
export async function openFixture(page:Page,testInfo:TestInfo,options:{mobileLifecycle?:boolean;profileProbe?:boolean;staleProbe?:boolean;revisionDelay?:number;subscription?:boolean;boundSource?:boolean;startError?:boolean;health?:"healthy"|"checking"|"unavailable"|"reality";parseFailure?:boolean;running?:boolean;selectedFirst?:boolean;tab?:string;customRouting?:boolean;single?:boolean;locale?:string;theme?:string;accent?:string}={}){
  const mobile=testInfo.project.name==="mobile";
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  await page.route("**/*",route=>route.request().url().startsWith("http://127.0.0.1:1438")?route.continue():route.abort());
  await page.addInitScript(({mobile,options,v1})=>{
    const fixture=(tag:string,uuid:string)=>({protocol:"vless",tag,server:"127.0.0.1",port:12345,uuid,transport:{kind:"tcp"},tls:{enabled:false,alpn:[],allow_insecure:false}});
    if(!sessionStorage.getItem("fixture-seeded")){
      localStorage.setItem(v1,JSON.stringify(options.single?[fixture("My server","one")]:options.selectedFirst?[fixture("First","one"),fixture("Second","two")]:[fixture("Same","one"),fixture("Same","two")]));
      localStorage.setItem("cloakwire:locale",options.locale??"en");
      if(options.theme)localStorage.setItem("cloakwire:theme-mode",options.theme);
      if(options.accent)localStorage.setItem("cloakwire:accent",options.accent);
      localStorage.setItem(mobile?"singbox.mobile.tab":"singbox.tab",options.tab??"servers");
      if(options.customRouting)localStorage.setItem("singbox-client.settings.v2",JSON.stringify({tunnel_mode:"tun",routing:{vpn_processes:[],direct_processes:[],final_outbound:mobile?"proxy":"direct",rules:[],rule_sets:[],tun_app_mode:"all",tun_app_list:[]}}));
      localStorage.setItem(mobile?"singbox.mobile.lastServer":"cloakwire.desktop.lastServer.v1",JSON.stringify(mobile?{kind:"profile",tag:options.single?"My server":options.selectedFirst?"First":"Same"}:{kind:"profile",key:options.single?"manual:My server":options.selectedFirst?"manual:First":"manual:Same"}));
      sessionStorage.setItem("fixture-seeded","1");
    }
    const w=window as any;w.nativeCalls=[];w.nativeRequests=[];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    w.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(cmd:string,args:any={})=>{
      w.nativeCalls.push(cmd);w.nativeRequests.push({cmd,args});
      if(options.mobileLifecycle&&mobile){
        const current=()=>w.mobileStatus??={state:options.running?"running":"stopped",run_id:options.running?"run-a":null,message:null,since:Date.now(),engine:"sing-box",profile_name:"First"};
        const emit=()=>w.statusListener?.onmessage(current());
        if(cmd==="plugin:vpn|register_listener"&&args.event==="status"){w.statusListener=args.handler;return null;}
        if(cmd==="plugin:vpn|status")return current();
        if(cmd==="plugin:vpn|stop"){w.mobileStatus={...current(),state:"stopped",run_id:null};emit();return null;}
        if(cmd==="plugin:vpn|start"){
          await new Promise(r=>setTimeout(r,100));
          if(args.expectedRunId!==(current().run_id??"stopped"))throw "profile_check_failed";
          if(options.startError)throw "profile_check_invalid";
          w.mobileStatus={state:"running",run_id:"run-b",message:null,since:Date.now(),engine:args.engine==="xray"?"xray":"sing-box",profile_name:args.name,source:JSON.parse(args.source)};
          emit();return null;
        }
      }
      if(options.profileProbe){
        const snapshot=()=>({selected_profile:w.selectedProbe??null,active_session:null});
        if(cmd==="plugin:vpn|register_listener"&&args.event==="probe"){w.probeListener=args.handler;return null;}
        if(cmd==="plugin:vpn|probeSnapshot"){
          if(options.staleProbe&&!w.selectedProbe)w.selectedProbe={profile_ref:{kind:"manual",id:"previous-server"},profile_revision:"old",run_id:null,network_generation:"old-network",effective_outbound_revision:null,operation_id:"old-result",scope:"selected_profile",stage:"complete",outcome:"failed",issue:"authentication",checked_at:new Date().toISOString(),latency_ms:null};
          return snapshot();
        }
        if(cmd==="plugin:vpn|probe"){
          const source=JSON.parse(args.source),id="probe-"+(w.probeStarts=(w.probeStarts??0)+1);
          w.selectedProbe={profile_ref:source.profile_ref,profile_revision:source.source_revision,run_id:null,network_generation:"physical",effective_outbound_revision:null,operation_id:id,scope:"selected_profile",stage:"preparing",outcome:"checking",issue:null,checked_at:null,latency_ms:null};
          return {operation_id:id};
        }
        if(cmd==="run_android_profile_probe"){
          if(w.selectedProbe?.operation_id!==args.operationId)throw Error("profile_check_cancelled");
          w.selectedProbe={...w.selectedProbe,stage:"complete",outcome:"healthy",checked_at:new Date().toISOString(),latency_ms:25};
          w.probeListener?.onmessage(snapshot());return null;
        }
        if(cmd==="plugin:vpn|cancelProbe"){
          if(w.selectedProbe?.operation_id===args.operationId)w.selectedProbe=null;
          w.probeListener?.onmessage(snapshot());return null;
        }
      }
      if(cmd==="profile_source_revisions"){if(options.revisionDelay)await new Promise(r=>setTimeout(r,options.revisionDelay));return args.outbounds.map((o:any)=>(o.uuid==="one"?"a":"b").repeat(64));}
      if(cmd==="profile_catalog_epoch")return "1";
      if(cmd==="plugin:vpn|beginProfilePreparation")return {request:"1"};
      if(cmd==="plugin:vpn|prepare")return {prepared:true};
      if(cmd==="generate_config")return {outbounds:args.outbounds};
      if(cmd==="plugin:vpn|start"||cmd==="start_managed_singbox"){if(options.startError){await new Promise(r=>setTimeout(r,250));throw {kind:"validation",message:"profile_check_invalid"};}return {status:{status:"running",run_id:"8",engine:"singbox"},config_path:"fixture",routing:{unavailable:[]}};}
      if(cmd==="update_tray_status"){w.lastTray=args;return null;}
      if(cmd==="parse_input"&&options.parseFailure)return {outbounds:[],subscriptions:[],failures:[{line:1,input:"vless://SYNTHETIC",error:{kind:"parse",message:"Invalid port number"}}]};
      if(cmd==="parse_input")return {outbounds:[fixture("Provider label","NEW_SECRET")],subscriptions:[],failures:[]};
      if(cmd==="list_processes")return [{pid:123,name:"fixture.exe"}];
      if(cmd==="plugin:vpn|listApps")return [{packageName:"fixture.app",label:"Fixture app"}];
      const sub=()=>({id:"sub-a",name:"Provider A",kind:"singbox_bundle",engine:"singbox",interval_minutes:60,active_child_key:"child-0",children:[{key:"child-0",name:w.subChanged?"Updated server A":"Ready server A",engine:"singbox",source_revision:(w.subChanged?"b":"a").repeat(64)}],metadata:{},last_success_at:new Date().toISOString(),server_count:1});
      if(cmd==="list_subscriptions")return {subscriptions:options.subscription?[sub()]:[],link_outbounds:[]};
      if(cmd==="refresh_subscription"){w.refreshCount=(w.refreshCount??0)+1;if(w.refreshCount>1)w.subChanged=true;return {subscription:sub(),changed:!!w.subChanged};}
      if(cmd==="set_active_child"||cmd==="select_subscription_child")return sub();
      if(cmd==="get_active_child_config")return {engine:"singbox",child_key:"child-0",child_name:sub().children[0].name,source_revision:sub().children[0].source_revision,config:"{}"};

      if(cmd==="get_connection_diagnostics"){
        if(!options.health)return null;
        const w=window as any;
        if(!w.fixtureHealth){
          const session={profile_ref:{kind:"manual",id:"accepted-a"},profile_revision:"native-a",run_id:"7",network_generation:"network-a",effective_outbound_revision:"member-a",engine:"singbox",display_name:"Accepted server A"};
          w.fixtureHealth={session,health:{...session,operation_id:"initial",scope:"active_session",stage:options.health==="checking"?"verifying":"complete",outcome:options.health==="reality"?"unavailable":options.health,issue:options.health==="reality"?"probe_target_unavailable":options.health==="unavailable"?"unsupported_probe":null,checked_at:new Date().toISOString(),latency_ms:options.health==="healthy"?14:null},
            issue:options.health==="reality"?{run_id:"7",code:"reality_verification",severity:"notice",count:2,observed_at:new Date().toISOString()}:null,ended_unexpectedly:false};
        }
        if(options.boundSource){const records=JSON.parse(localStorage.getItem("singbox-client.manual-profiles.v2")??"null")?.records;if(records?.[0]){w.fixtureHealth.session.profile_ref={kind:"manual",id:records[0].id};w.fixtureHealth.session.source_revision="a".repeat(64);w.fixtureHealth.health={...w.fixtureHealth.health,profile_ref:w.fixtureHealth.session.profile_ref};}}
        if(options.subscription){const ref={kind:"ready",subscription_id:"sub-a",child_key:"child-0"};w.fixtureHealth.session.profile_ref=ref;w.fixtureHealth.session.source_revision="a".repeat(64);w.fixtureHealth.health.profile_ref=ref;}
        return w.fixtureHealth;
      }
      if(cmd==="retry_active_probe"){
        const w=window as any;(w.probeCalls??=[]).push(args.expected);
        w.fixtureHealth.health={...w.fixtureHealth.session,operation_id:"retry",scope:"active_session",stage:"verifying",outcome:"checking",issue:null,checked_at:null,latency_ms:null};
        return "retry";
      }
      if(cmd==="get_status"&&w.statusOverride)return w.statusOverride;
      if(cmd==="get_status"&&options.health)return {status:"running",run_id:(window as any).fixtureRun??"7",engine:"singbox",pid:123,uptime_secs:1,last_exit_code:null,last_error:null};
      if(cmd==="get_status")return {status:options.running?"running":"stopped",pid:options.running?123:null,uptime_secs:null,last_exit_code:null,last_error:null};
      if(cmd==="plugin:vpn|status")return {state:options.running?"running":"stopped",message:null,since:null,engine:""};
      if(cmd==="get_binary_info")return {path:"fixture",exists:true};
      if(cmd==="get_singbox_version")return {version:"fixture",raw:"fixture"};
      if(cmd==="get_xray_version")return "fixture";
      if(cmd==="check_app_update")return {available:false,current_version:"1.4.9",version:"1.4.9"};
      if(cmd==="get_logs"||cmd==="lookup_geoip")return [];
      if(cmd==="plugin:app|version")return "1.4.9";
      if(cmd==="get_autostart")return false;
      if(cmd==="plugin:vpn|traffic")return {up:0,down:0,upTotal:0,downTotal:0};
      if(cmd==="get_device_hwid")return {id:"fixture",effective:"fixture"};
      return null;
    }};
  },{mobile,options,v1});
  await page.goto("/"+(mobile?"?mobile=1":""),{waitUntil:"domcontentloaded"});
  return {mobile,verify:async()=>{
    expect(errors).toEqual([]);
    expect(await page.evaluate(()=>(window as any).nativeCalls.some((x:string)=>x==="start_managed_singbox"||x==="plugin:vpn|start"))).toBe(false);
  }};
}
export async function records(page:Page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).records,v2);}
export async function settings(page:Page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),settingsKey);}
