// Authorized real-device test: disposable local VLESS server, ready profiles, and independent-UID traffic.
// Does not reconnect the active VPN. Requires the debug app and CloakwireDeviceProbe helper installed.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import {execFileSync,spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {chromium} from "playwright";
import {sameConfig,userAppPid} from "./android-device-check-helpers.mjs";
import {observeTraffic} from "./android-isolation-check-helpers.mjs";
const args=Object.fromEntries(process.argv.slice(2).reduce((rows,key,index,list)=>
 key.startsWith("--")?[...rows,[key.slice(2),list[index+1]&&!list[index+1].startsWith("--")?list[index+1]:true]]:rows,[]));
if(!args.adb||!args.serial||!args.output||args["exercise-vpn"]!==true||!["singbox","xray"].includes(args["probe-engine"]||"xray"))
 throw Error("Required --adb <path> --serial <device> --output <report> --probe-engine singbox|xray --exercise-vpn");
const root=process.cwd(),dir=path.dirname(path.resolve(args.output)),app="app.cloakwire.client";
const adb=(...a)=>execFileSync(args.adb,["-s",args.serial,...a],{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:15000,maxBuffer:8*1024*1024}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const apkHash=()=>adb("shell","sha256sum",adb("shell","pm","path",app).split("\n")[0].replace("package:","")).split(/\s+/)[0];
let port,browser,page;
async function invoke(command,payload={}){
 const result=await page.evaluate(async({command,payload})=>{
  try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,payload)}}catch{return {ok:false}}
 },{command,payload});
 if(!result.ok)throw Error("native_call_failed");
 return result.value;
}
try{
 fs.mkdirSync(dir,{recursive:true});
 adb("shell","am","start","--user","0","-n",app+"/.MainActivity");
 const appPid=userAppPid(adb("shell","ps","-A","-o","PID,USER,NAME"),app);
 port=adb("forward","tcp:0","localabstract:webview_devtools_remote_"+appPid);
 browser=await chromium.connectOverCDP("http://127.0.0.1:"+port);
 page=browser.contexts()[0].pages()[0];
 await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
 if((await invoke("plugin:vpn|status")).state!=="running")throw Error("running_vpn_required");
  const stored=await page.evaluate(()=>({settings:JSON.parse(localStorage.getItem("singbox-client.settings.v2"))}));
  const original=await invoke("plugin:vpn|status"),config=adb("exec-out","run-as",app,"cat","files/xray-config.json");
  const unchanged=async()=>{const now=await invoke("plugin:vpn|status");return now.state===original.state&&now.run_id===original.run_id&&now.since===original.since&&sameConfig(config,adb("exec-out","run-as",app,"cat","files/xray-config.json"))};
  const fixtureEngine=args["probe-engine"]||"xray";
  const report={cases:[],activeEngine:original.engine,probeEngine:fixtureEngine,apkSha256:apkHash()},reportFile=path.resolve(args.output);
  const check=(name,pass,details={})=>{report.cases.push({name,status:pass?"PASS":"FAIL",...details});fs.writeFileSync(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report.cases.at(-1)));if(!pass)throw Error(name)};
  const wait=async(id)=>{for(let n=0;n<100;n++){const h=(await invoke("plugin:vpn|probeSnapshot")).selected_profile;if(h?.operation_id===id&&h.outcome!=="checking")return h;await sleep(160)}throw Error("result_timeout")};

  const pid=()=>adb("shell","ps","-A","-o","PID,USER,NAME").split("\n").map(s=>s.trim().split(/\s+/)).find(r=>r[2]===app+":profile_diagnostics"&&/^u0_a/.test(r[1]))?.[0];
  const traffic=async(operationId)=>{
   const expected=operationId?pid():null;
   const report=await observeTraffic({
    start:async()=>{adb("shell","am","force-stop","--user","0","app.cloakwire.deviceprobe");adb("shell","run-as","app.cloakwire.deviceprobe","rm","-f","files/result.json");adb("shell","am","start","--user","0","-n","app.cloakwire.deviceprobe/.ProbeActivity")},
    read:async()=>JSON.parse(adb("shell","run-as","app.cloakwire.deviceprobe","cat","files/result.json")),
    isActive:async()=>!operationId||(!!expected&&pid()===expected&&(await invoke("plugin:vpn|probeSnapshot")).selected_profile?.operation_id===operationId&&(await invoke("plugin:vpn|probeSnapshot")).selected_profile?.outcome==="checking"),
    wait:sleep,timeoutMs:operationId?9000:25000
   });
   return {pass:!report.failure&&report.result?.defaultIsVpn===true&&report.result?.https204===true&&report.result?.networkUnchanged===true,
    defaultIsVpn:report.result?.defaultIsVpn===true,https204:report.result?.https204===true,failure:report.failure??null};
  };

  const alloc=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));const port=s.address().port;await new Promise(r=>s.close(r));return port};
  const serverPort=await alloc(),uuid=randomUUID(),serverFile=path.join(dir,"synthetic-"+uuid+".json");
  fs.writeFileSync(serverFile,JSON.stringify({log:{loglevel:"none"},inbounds:[{listen:"127.0.0.1",port:serverPort,protocol:"vless",settings:{clients:[{id:uuid}],decryption:"none"}}],outbounds:[{protocol:"freedom",settings:{}}]}));
  const server=spawn(path.resolve(args.core||"src-tauri/binaries/xray-x86_64-pc-windows-msvc.exe"),["run","-c",serverFile],{stdio:"ignore",windowsHide:true});
  const ready=(id,remark)=>fixtureEngine==="singbox"?({remarks:remark,inbounds:[{type:"socks",listen:"127.0.0.1",listen_port:2080}],outbounds:[{type:"vless",tag:"fixture-proxy",server:"127.0.0.1",server_port:serverPort,uuid:id}],dns:{servers:[{tag:"local",type:"local"}]},route:{final:"fixture-proxy",default_domain_resolver:"local"}}):({remarks:remark,inbounds:[{protocol:"socks",listen:"127.0.0.1",port:2080}],outbounds:[{tag:"fixture-proxy",protocol:"vless",settings:{vnext:[{address:"127.0.0.1",port:serverPort,users:[{id,encryption:"none"}]}]},streamSettings:{network:"tcp",security:"none"}}],routing:{domainStrategy:"AsIs"}});

  const sinkSockets=new Set();const sink=net.createServer(socket=>{sinkSockets.add(socket);socket.on("close",()=>sinkSockets.delete(socket));socket.on("error",()=>{});socket.resume()});
  await new Promise(r=>sink.listen(0,"127.0.0.1",r));const sinkPort=sink.address().port;
  const held=ready(uuid,"held-fixture");if(fixtureEngine==="xray")held.outbounds[0].settings.vnext[0].port=sinkPort;else held.outbounds[0].server_port=sinkPort;
  const payload=JSON.stringify([ready(uuid,"valid-fixture"),ready(randomUUID(),"wrong-key-fixture"),held]);
  const subscriptionServer=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end(payload)});
  await new Promise(r=>subscriptionServer.listen(0,"127.0.0.1",r));const subscriptionPort=subscriptionServer.address().port;
  let subscription;
  try{
   adb("reverse","tcp:"+sinkPort,"tcp:"+sinkPort);adb("reverse","tcp:"+serverPort,"tcp:"+serverPort);adb("reverse","tcp:"+subscriptionPort,"tcp:"+subscriptionPort);
   await sleep(300);check("synthetic_xray_server_alive",server.exitCode===null);
   const added=await invoke("add_subscription",{input:{name:"Temporary diagnostic fixture",url:"http://127.0.0.1:"+subscriptionPort+"/profiles",intervalMinutes:60}});
   subscription=added.subscription;
   check("ready_"+fixtureEngine+"_fixture_imported",subscription.kind===fixtureEngine+"_bundle"&&subscription.children.length===3);

   const baseline=await traffic();check("ordinary_uid_baseline",baseline.pass,baseline);
   const heldChild=subscription.children[2],heldSource={profile_ref:{kind:"ready",subscription_id:subscription.id,child_key:heldChild.key},source_revision:heldChild.source_revision};
   const heldId=(await invoke("plugin:vpn|probe",{source:JSON.stringify(heldSource)})).operation_id;
   await invoke("run_android_profile_probe",{operationId:heldId,profileRef:heldSource.profile_ref,sourceRevision:heldSource.source_revision,outbound:null,settings:stored.settings});
   let childAlive=false;
   for(let n=0;n<20;n++){const parent=pid();const rows=adb("shell","ps","-A","-o","PID,PPID,USER,NAME").split("\n").map(s=>s.trim().split(/\s+/));childAlive=!!parent&&(fixtureEngine==="singbox"||rows.some(r=>r[1]===parent&&r[3]?.includes("libxray")));if(childAlive)break;await sleep(50)}
   check("owned_"+fixtureEngine+"_probe_is_running",childAlive);
   const during=await traffic(heldId);check("ordinary_uid_https_during_"+fixtureEngine+"_probe",during.pass,during);
   await invoke("plugin:vpn|cancelProbe",{operationId:heldId});await sleep(2300);
   check(fixtureEngine+"_cancel_removes_diagnostic_process",!pid()&&await unchanged());
   for(const [index,expected]of [[0,"healthy"],[1,"failed"]]){
    const child=subscription.children[index],source={profile_ref:{kind:"ready",subscription_id:subscription.id,child_key:child.key},source_revision:child.source_revision};
    const id=(await invoke("plugin:vpn|probe",{source:JSON.stringify(source)})).operation_id;
    await invoke("run_android_profile_probe",{operationId:id,profileRef:source.profile_ref,sourceRevision:source.source_revision,outbound:null,settings:stored.settings});
    const result=await wait(id);
    check(index===0?"ready_"+fixtureEngine+"_https_success":"wrong_credentials_cannot_succeed_through_active_vpn",result.outcome===expected,{outcome:result.outcome,issue:result.issue});
    check("active_vpn_preserved_after_fixture_"+index,await unchanged());
   }
  }finally{
   if(subscription)await invoke("remove_subscription",{id:subscription.id});
   for(const p of [serverPort,subscriptionPort,sinkPort])try{adb("reverse","--remove","tcp:"+p)}catch{}
   await new Promise(r=>subscriptionServer.close(r));for(const socket of sinkSockets)socket.destroy();await new Promise(r=>sink.close(r));server.kill();fs.rmSync(serverFile,{force:true});
  }
  check("temporary_subscription_removed",!(await invoke("list_subscriptions")).subscriptions.some(s=>s.id===subscription.id));
  check("original_session_preserved",await unchanged());

}catch(error){console.error("Profile probe device check failed: "+error.name);process.exitCode=1}
finally{
 if(browser)await browser.close().catch(()=>{});
 if(port)try{adb("forward","--remove","tcp:"+port)}catch{process.exitCode=1}
}
