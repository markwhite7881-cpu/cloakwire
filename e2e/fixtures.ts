import {expect,type Page,type TestInfo} from "playwright/test";
export const v1="singbox-client.manual-profiles.v1",v2="singbox-client.manual-profiles.v2";
export const settingsKey="singbox-client.settings.v2";
export async function openFixture(page:Page,testInfo:TestInfo,options:{tab?:string;customRouting?:boolean;single?:boolean;locale?:string;theme?:string;accent?:string}={}){
  const mobile=testInfo.project.name==="mobile";
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  await page.route("**/*",route=>route.request().url().startsWith("http://127.0.0.1:1438")?route.continue():route.abort());
  await page.addInitScript(({mobile,options,v1})=>{
    const fixture=(tag:string,uuid:string)=>({protocol:"vless",tag,server:"127.0.0.1",port:12345,uuid,transport:{kind:"tcp"},tls:{enabled:false,alpn:[],allow_insecure:false}});
    if(!sessionStorage.getItem("fixture-seeded")){
      localStorage.setItem(v1,JSON.stringify(options.single?[fixture("My server","one")]:[fixture("Same","one"),fixture("Same","two")]));
      localStorage.setItem("cloakwire:locale",options.locale??"en");
      localStorage.setItem(mobile?"singbox.mobile.tab":"singbox.tab",options.tab??"servers");
      if(options.customRouting)localStorage.setItem("singbox-client.settings.v2",JSON.stringify({tunnel_mode:"tun",routing:{vpn_processes:[],direct_processes:[],final_outbound:mobile?"proxy":"direct",rules:[],rule_sets:[],tun_app_mode:"all",tun_app_list:[]}}));
      localStorage.setItem(mobile?"singbox.mobile.lastServer":"cloakwire.desktop.lastServer.v1",JSON.stringify(mobile?{kind:"profile",tag:"Same"}:{kind:"profile",key:"manual:Same"}));
      sessionStorage.setItem("fixture-seeded","1");
    }
    const w=window as any;w.nativeCalls=[];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    w.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(cmd:string)=>{
      w.nativeCalls.push(cmd);
      if(cmd==="parse_input")return {outbounds:[fixture("Provider label","NEW_SECRET")],subscriptions:[],failures:[]};
      if(cmd==="list_processes")return [{pid:123,name:"fixture.exe"}];
      if(cmd==="plugin:vpn|listApps")return [{packageName:"fixture.app",label:"Fixture app"}];
      if(cmd==="list_subscriptions")return {subscriptions:[],link_outbounds:[]};
      if(cmd==="get_status")return {status:"stopped",pid:null,uptime_secs:null,last_exit_code:null,last_error:null};
      if(cmd==="plugin:vpn|status")return {state:"stopped",message:null,since:null,engine:""};
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
