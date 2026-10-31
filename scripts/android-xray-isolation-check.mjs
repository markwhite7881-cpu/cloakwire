import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {execFileSync} from "node:child_process";
import {chromium} from "playwright";
import {userAppPid,sameConfig} from "./android-device-check-helpers.mjs";

const argv=process.argv.slice(2),args=Object.fromEntries(argv.filter((_,i)=>i%2===0).map((key,i)=>[key.slice(2),argv[i*2+1]]));
if(!args.adb||!args.serial||!args.output)throw Error("Required --adb --serial --output; authorized test device only");
const app="app.cloakwire.client",helper="app.cloakwire.deviceprobe",resultFile="files/diagnostics-isolation-result.json";
const adb=(...a)=>execFileSync(args.adb,["-s",args.serial,...a],{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:15000}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={cases:[],preserved:false,cleanup:false};
const check=(name,pass)=>{report.cases.push({name,pass:!!pass});console.log(JSON.stringify(report.cases.at(-1)));if(!pass)throw Error(name)};
let browser,page,forward,reverse,original,config,mainPid,ownerUid,baseline=[],orphan=false;
const requests=[],responses=new Set();
const fixture=http.createServer((request,response)=>{
 response.on("close",()=>responses.delete(response));responses.add(response);
 requests.push({response,valid:request.url==="/generate_204"&&request.headers.host==="www.gstatic.com"});
});
const rows=()=>adb("shell","ps","-A","-o","PID,USER,NAME").split("\n").map(s=>s.trim().split(/\s+/));
const cores=()=>rows().filter(r=>r[1]===ownerUid&&r[2]==="libxray.so").map(r=>r[0]);
const diagnosticPid=()=>rows().find(r=>r[1]===ownerUid&&r[2]===app+":diagnostics")?.[0];
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("plugin:vpn|status"));
async function unchanged(){
 const now=await status();
 return now.state==="running"&&now.run_id===original.run_id&&now.engine===original.engine&&
   sameConfig(config,adb("exec-out","run-as",app,"cat","files/xray-config.json"))&&baseline.every(pid=>cores().includes(pid));
}
async function until(predicate,ms=5000){
 const end=Date.now()+ms;do{if(await predicate())return true;await sleep(100)}while(Date.now()<end);return false;
}
function launch(mode){
 adb("shell","run-as",app,"rm","-f",resultFile);
 adb("shell","am","start","--user","0","-n",app+"/.vpn.DiagnosticIsolationActivity","--es","mode",mode,"--ei","fixturePort",reverse);
}
async function begin(){
 const cursor=requests.length,previous=cores();launch("xray-latency");
 let child;
 if(!await until(()=>{child=cores().find(pid=>!previous.includes(pid));return !!child},4000))throw Error("temporary_xray_not_started");
 if(!await until(()=>requests.length>cursor,5500))throw Error("local_fixture_not_reached");
 const request=requests[cursor];
 if(!request.valid)throw Error("unexpected_fixture_request");
 return {child,driver:diagnosticPid(),response:request.response};
}
async function ordinaryTraffic(probe){
 adb("shell","am","force-stop","--user","0",helper);
 adb("shell","run-as",helper,"rm","-f","files/result.json");
 adb("shell","am","start","--user","0","-n",helper+"/.ProbeActivity");
 let result;
 const live=()=>cores().includes(probe.child)&&diagnosticPid()===probe.driver;
 const done=await until(()=>{
  if(!live())throw Error("probe_ended_before_ordinary_request");
  try{result=JSON.parse(adb("exec-out","run-as",helper,"cat","files/result.json"));return true}catch{return false}
 },4500);
 return done&&live()&&result.defaultIsVpn===true&&result.https204===true&&result.networkUnchanged===true;
}
async function finished(){
 let result;
 if(!await until(()=>{try{result=JSON.parse(adb("exec-out","run-as",app,"cat",resultFile));return result.state==="latency_done"}catch{return false}}))return false;
 return result.success===true&&await until(()=>!diagnosticPid());
}
try{
 adb("shell","am","start","--user","0","-n",app+"/.MainActivity");
 mainPid=userAppPid(adb("shell","ps","-A","-o","PID,USER,NAME"),app);
 ownerUid=rows().find(r=>r[0]===mainPid)[1];baseline=cores();
 forward=adb("forward","tcp:0","localabstract:webview_devtools_remote_"+mainPid);
 browser=await chromium.connectOverCDP("http://127.0.0.1:"+forward);page=browser.contexts()[0].pages()[0];
 original=await status();config=adb("exec-out","run-as",app,"cat","files/xray-config.json");
 check("requires_running_vpn",original.state==="running");
 await new Promise(resolve=>fixture.listen(0,"127.0.0.1",resolve));
 reverse=adb("reverse","tcp:0","tcp:"+fixture.address().port);
 if(!/^\d+$/.test(reverse))throw Error("reverse_unavailable");

 let probe=await begin();
 check("real_temporary_xray_reaches_owned_http_fixture",!baseline.includes(probe.child)&&!!probe.driver);
 check("ordinary_https_while_temporary_xray_is_alive",await ordinaryTraffic(probe)&&await unchanged());
 probe.response.writeHead(204);probe.response.end();
 check("temporary_xray_completion_preserves_vpn",await finished()&&await until(()=>!cores().includes(probe.child))&&await unchanged());

 probe=await begin();launch("cancel");
 check("temporary_xray_cancel_reaps_only_owned_child",await until(()=>!diagnosticPid()&&!cores().includes(probe.child))&&await unchanged());

 probe=await begin();const oldChild=probe.child;launch("crash");orphan=true;
 check("diagnostic_owner_crash_preserves_vpn",await until(()=>!diagnosticPid())&&await unchanged());
 report.orphanSurvivedOwner=cores().includes(oldChild);
 probe=await begin();orphan=false;
 check("no_old_child_survives_fresh_probe",!cores().includes(oldChild)&&await unchanged());
 probe.response.writeHead(204);probe.response.end();
 check("fresh_temporary_xray_after_owner_death",await finished()&&await until(()=>!cores().includes(probe.child))&&await unchanged());
 report.preserved=await unchanged();
}catch(error){report.error=/^[a-z_]+$/.test(error.message)?error.message:"device_check_failed";process.exitCode=1;}
finally{
 try{
  if(orphan){launch("xray-latency");await sleep(250);}
  launch("cancel");
  report.cleanup=await until(()=>!diagnosticPid()&&cores().length===baseline.length);
 }catch{}
 for(const response of responses)response.destroy();
 fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
 try{report.preserved=!!original&&await unchanged()}catch{}
 if(!report.cleanup||!report.preserved)process.exitCode=1;
 if(browser)await browser.close().catch(()=>{});
 if(forward)try{adb("forward","--remove","tcp:"+forward)}catch{}
 if(reverse)try{adb("reverse","--remove","tcp:"+reverse)}catch{}
 adb("shell","am","start","--user","0","-n",app+"/.MainActivity");
 fs.mkdirSync(path.dirname(args.output),{recursive:true});fs.writeFileSync(args.output,JSON.stringify(report,null,2));
 console.log(JSON.stringify({preserved:report.preserved,cleanup:report.cleanup,orphanSurvivedOwner:report.orphanSurvivedOwner,error:report.error??null}));
}
