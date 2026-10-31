import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {chromium} from "playwright";
import {userAppPid,sameConfig} from "./android-device-check-helpers.mjs";
const args=Object.fromEntries(process.argv.slice(2).filter((_,i)=>i%2===0).map((key,i)=>[key.slice(2),process.argv.slice(2)[i*2+1]]));
if(!args.adb||!args.serial||!args.output)throw Error("Required --adb --serial --output; authorized test device only");
const app="app.cloakwire.client",component=app+"/.vpn.DiagnosticIsolationActivity",file="files/diagnostics-isolation-result.json";
const adb=(...a)=>execFileSync(args.adb,["-s",args.serial,...a],{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:15000,maxBuffer:1024*1024}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={cases:[],preserved:false};
let browser,port,page,original,config;
const check=(name,pass)=>{report.cases.push({name,pass});console.log(JSON.stringify({name,pass}));if(!pass)throw Error(name)};
const invoke=(cmd,args={})=>page.evaluate(async({cmd,args})=>{try{return await window.__TAURI_INTERNALS__.invoke(cmd,args)}catch{throw Error("native_call_failed")}}, {cmd,args});
const snapshot=()=>invoke("plugin:vpn|status");
const pidOf=name=>{const rows=adb("shell","ps","-A","-o","PID,USER,NAME").split("\n").map(s=>s.trim().split(/\s+/));return rows.find(r=>r[2]===name&&/^u0_a\d+$/.test(r[1]))?.[0]};
async function traffic(){
 const helper="app.cloakwire.deviceprobe";
 adb("shell","am","force-stop","--user","0",helper);
 adb("shell","run-as",helper,"rm","-f","files/result.json");
 adb("shell","am","start","--user","0","-n",helper+"/.ProbeActivity");
 const until=Date.now()+12000;
 while(Date.now()<until){
  try{const r=JSON.parse(adb("shell","run-as",helper,"cat","files/result.json"));return r.defaultIsVpn===true&&r.https204===true&&r.networkUnchanged===true}catch{}
  await sleep(150);
 }
 return false;
}
async function unchanged(){
 const now=await snapshot();return now.state==="running"&&now.run_id===original.run_id&&now.engine===original.engine&&sameConfig(config,adb("exec-out","run-as",app,"cat","files/xray-config.json"));
}
async function launch(mode){
 adb("shell","run-as",app,"rm","-f",file);
 let out;try{out=adb("shell","am","start","--user","0","-n",component,"--es","mode",mode)}catch{throw Error("isolation_activity_unavailable")}
 if(/Error|does not exist/i.test(out))throw Error("isolation_activity_unavailable");
}
async function result(state,timeout=18000){
 const until=Date.now()+timeout;
 while(Date.now()<until){
  try{const r=JSON.parse(adb("exec-out","run-as",app,"cat",file));if(r.state==="failed")throw Error("isolation_failed_"+(r.stage??"unknown"));if(r.state===state)return r}catch(e){if(e.message.startsWith("isolation_failed_"))throw e}
  if(!await unchanged())throw Error("active_vpn_changed");
  await sleep(150);
 }
 throw Error("isolation_timeout");
}
async function gone(name){
 const until=Date.now()+5000;while(Date.now()<until){if(!pidOf(name))return true;await sleep(100)}return false;
}
try{
 adb("shell","am","start","--user","0","-n",app+"/.MainActivity");
 const pid=userAppPid(adb("shell","ps","-A","-o","PID,USER,NAME"),app);
 port=adb("forward","tcp:0","localabstract:webview_devtools_remote_"+pid);
 browser=await chromium.connectOverCDP("http://127.0.0.1:"+port);
 page=browser.contexts()[0].pages()[0];
 original=await snapshot();config=adb("exec-out","run-as",app,"cat","files/xray-config.json");
 check("requires_running_vpn",original.state==="running");
 await launch("hold");
 const ready=await result("ready");
 check("separate_process_and_private_command_channel",ready.pid!==Number(pid)&&ready.commandConnected&&ready.privatePaths);
 check("physical_socket_binding_and_dns",ready.boundSockets>=2&&ready.dnsResolved&&ready.udpRelay&&ready.https204);
 check("active_session_unchanged_during_probe",await unchanged());
 check("ordinary_app_https_while_probe_active",await traffic()&&await unchanged());
 await launch("cancel");
 await result("cancelled");
 check("cancel_reaps_only_diagnostic_process",await gone(app+":diagnostics")&&await unchanged());
 check("ordinary_app_https_after_probe_cancel",await traffic()&&await unchanged());
 await launch("tun");
 const tun=await result("tun_rejected");
 check("core_cannot_create_tun",tun.tunRejected===true&&await unchanged());
 await gone(app+":diagnostics");
 await launch("hold");
 await result("ready");
 const driver=pidOf(app+":diagnostic_driver");
 check("driver_is_separate_from_vpn",!!driver&&driver!==pid);
 adb("shell","run-as",app,"kill","-9",driver);
 check("client_death_reaps_diagnostics",await gone(app+":diagnostics")&&await unchanged());
 await launch("hold");
 await result("ready");
 await launch("crash");
 check("diagnostic_crash_preserves_vpn",await gone(app+":diagnostics")&&await unchanged());
 await launch("hold");
 await result("ready");
 await launch("cancel");
 await result("cancelled");
 check("fresh_probe_after_crash_is_independent",await gone(app+":diagnostics")&&await unchanged());
 report.preserved=await unchanged();
}catch(e){report.error=/^[a-z_]+$/.test(e.message)?e.message:"device_check_failed";process.exitCode=1;}
finally{
 try{await launch("cancel");await sleep(300)}catch{}
 try{report.preserved=original?await unchanged():false}catch{}
 if(!report.preserved)process.exitCode=1;
 if(browser)await browser.close().catch(()=>{});
 if(port)try{adb("forward","--remove","tcp:"+port)}catch{}
 adb("shell","am","start","--user","0","-n",app+"/.MainActivity");
 fs.mkdirSync(path.dirname(args.output),{recursive:true});fs.writeFileSync(args.output,JSON.stringify(report,null,2));
 console.log(JSON.stringify({preserved:report.preserved,error:report.error??null}));
}
