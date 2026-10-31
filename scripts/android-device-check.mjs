import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {chromium} from "playwright";
import {readAcceptedConfig,sameConfig,sessionWasDisturbed,userAppPid} from "./android-device-check-helpers.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, xs) =>
  x.startsWith("--") ? [...a, [x.slice(2), xs[i+1] && !xs[i+1].startsWith("--") ? xs[i+1] : true]] : a, []));
if (!args.adb || !args.serial || !args.output || args["exercise-vpn"] !== true) {
  throw new Error("Required: --adb <path> --serial <id> --output <file> --exercise-vpn. Runs only on an explicitly authorized device.");
}
const app = "app.cloakwire.client", helper = "app.cloakwire.deviceprobe";
let port; const ownedPorts=new Set();
const report = {schema:1, startedAt:new Date().toISOString(), cases:[], restored:false};
const adb = (...a) => execFileSync(args.adb, ["-s",args.serial,...a], {encoding:"utf8", timeout:15000, maxBuffer:1024*1024, stdio:["ignore","pipe","pipe"]}).trim();
const acceptedConfig=()=>readAcceptedConfig(file=>{
  try {return adb("exec-out","run-as",app,"cat",file);}
  catch(e) { if(String(e.stderr||"").includes("No such file or directory")) e.code="ENOENT"; throw e; }
});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let browser, page;
async function connect() {
  if (browser) await browser.close().catch(()=>{});
  const until = Date.now()+15000;
  do {
    try {
      const pid = userAppPid(adb("shell","ps","-A","-o","PID,USER,NAME"),app);
      const sockets = adb("shell","cat","/proc/net/unix");
      if (!sockets.includes("@webview_devtools_remote_"+pid)) throw new Error("not ready");
      if(port) {adb("forward","--remove","tcp:"+port);ownedPorts.delete(port);port=undefined;}
      port=adb("forward","tcp:0","localabstract:webview_devtools_remote_"+pid);
      if(!/^\d+$/.test(port)) throw new Error("invalid_forward_port");
      ownedPorts.add(port);
      const r = await fetch("http://127.0.0.1:"+port+"/json/list", {signal:AbortSignal.timeout(1000)});
      if (!(await r.json()).length) throw new Error("not ready");
      browser = await chromium.connectOverCDP("http://127.0.0.1:"+port, {timeout:3000});
      page = browser.contexts()[0].pages()[0];
      await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__, {}, {timeout:3000});
      return;
    } catch { await sleep(250); }
  } while(Date.now()<until);
  throw new Error("webview_unavailable");
}
const invoke = (command, payload) => page.evaluate(({command,payload}) =>
  window.__TAURI_INTERNALS__.invoke(command,payload), {command,payload});
const status = ()=>invoke("plugin:vpn|status");
async function waitRunning(previousSince) {
  const until=Date.now()+20000;
  do {
    const s=await status();
    if (s.state==="running" && s.since!==previousSince) return s;
    if(s.state==="error") throw new Error("vpn_start_failed");
    await sleep(200);
  } while(Date.now()<until);
  throw new Error("vpn_start_timeout");
}
function record(name, pass, details={}) {
  report.cases.push({name,status:pass?"PASS":"FAIL",...details});
  console.log(JSON.stringify(report.cases.at(-1)));
  if(!pass) throw new Error(name);
}
async function networkProbe() {
  adb("shell","am","force-stop","--user","0",helper);
  adb("shell","run-as",helper,"rm","-f","files/result.json");
  adb("shell","am","start","--user","0","-n",helper+"/.ProbeActivity");
  const until=Date.now()+35000;
  do {
    try {
      const r=JSON.parse(adb("shell","run-as",helper,"cat","files/result.json"));
      // A private, fixed-schema report. Never forward response bodies or addresses.
      return Object.fromEntries(["defaultIsVpn","https204","defaultTraceOk","physicalTraceOk","egressDiffers","networkUnchanged","unavailable"]
        .filter(k=>typeof r[k]==="boolean").map(k=>[k,r[k]]));
    } catch { await sleep(250); }
  } while(Date.now()<until);
  throw new Error("network_probe_timeout");
}
let original, originalConfig, originalSettings, originalManual, originalPick, configOwner;
let changedVpn=false;
try {
  adb("shell","am","start","--user","0","-n",app+"/.MainActivity");
  await connect();
  original=await status();
  if(original.state!=="running" || original.engine!=="sing-box") throw new Error("requires_running_singbox_session");
  const storage=await page.evaluate(()=>({
    settings:localStorage.getItem("singbox-client.settings.v2"),
    manual:localStorage.getItem("singbox-client.manual-profiles.v2"),
    pick:localStorage.getItem("singbox.mobile.lastServer")
  }));
  originalSettings=storage.settings; originalManual=storage.manual; originalPick=storage.pick;
  const accepted=acceptedConfig(); originalConfig=accepted.raw; configOwner=accepted.path;
  const preferences=JSON.parse(originalSettings);
  if(preferences.kill_switch!=="off" || preferences.block_ipv6!==false) throw new Error("unsupported_safety_settings");
  const config=JSON.parse(originalConfig), tun=config.inbounds?.find(x=>x.type==="tun");
  if(!tun) throw new Error("active_tun_config_missing");
  const activeApps=tun.include_package?.length ? tun.include_package : (tun.exclude_package||[]);
  const activeMode=tun.include_package?.length ? "include" : "exclude";
  const restorePayload={config:originalConfig,engine:"singbox",apps:JSON.stringify(activeApps),appsMode:activeMode,
    name:original.profile_name||"",killSwitch:"off",blockIpv6:false};
  original.restorePayload=restorePayload;

  const pick=JSON.parse(originalPick), records=JSON.parse(originalManual).records;
  record("manual_selection_uses_stable_id",pick.kind==="manual" && records.some(r=>r.id===pick.id));
  for(const engine of ["singbox","xray"]) {
    const result=await page.evaluate(async engine=>{
      try {
        await window.__TAURI_INTERNALS__.invoke("plugin:vpn|start",{
          config:'{"outbounds":[{"type":"invalid-device-fixture","protocol":"invalid-device-fixture","tag":"fixture"}]}',
          engine,apps:"[]",appsMode:"exclude",name:"Invalid device fixture",killSwitch:"off",blockIpv6:false});
        return {rejected:false};
      } catch(e) {
        const raw=typeof e==="string"?e:e?.message;
        return {rejected:true,code:raw?.match(/^profile_check_[a-z_]+$/)?.[0]||"unclassified"};
      }
    },engine);
    const after=await status();
    record(engine+"_invalid_candidate_preserves_session",result.rejected && ["profile_check_invalid","profile_check_unsupported"].includes(result.code) &&
      after.state==="running" && after.since===original.since && after.engine===original.engine,{code:result.code});
  }

  report.cases.push({name:"activity_recreation_preserves_session",status:"NOT_RUN",reason:"Separate lifecycle test required; known Tauri 2.11.5 last-window process exit."});
  const base=await networkProbe();
  record("ordinary_app_https_through_tun",base.defaultIsVpn===true && base.https204===true && base.networkUnchanged===true,base);

  const engines=[{engine:"singbox",config:originalConfig}];
  if(args.xray===true) {
    const record=records.find(r=>r.id===pick.id);
    const config=await invoke("generate_xray_config",{outbounds:[record.outbound]});
    engines.push({engine:"xray",config:JSON.stringify(config)});
  }
  for(const candidate of engines) for(const mode of ["include","exclude"]) {
    adb("shell","am","start","--user","0","-n",app+"/.MainActivity");
    await connect();
    const old=await status();
    changedVpn=true;
    await invoke("plugin:vpn|start",{...restorePayload,...candidate,apps:JSON.stringify([helper]),appsMode:mode});
    await waitRunning(old.since);
    const attempts=[await networkProbe()];
    if(attempts[0].https204!==true || attempts[0].networkUnchanged!==true) { await sleep(1000); attempts.push(await networkProbe()); }
    const result=attempts.at(-1);
    record(candidate.engine+"_per_app_"+mode, result.defaultIsVpn===(mode==="include") && result.https204===true && result.networkUnchanged===true,{...result,attempts});
  }
} catch(e) {
  const allowed=["webview_unavailable","vpn_start_failed","vpn_start_timeout","network_probe_timeout",
    "requires_running_singbox_session","active_tun_config_missing","unsupported_safety_settings"];
  report.error=allowed.includes(e.message)?e.message: (/^profile_check_[a-z_]+$/.test(e?.message||"")?e.message:"device_check_failed");
  process.exitCode=1;
} finally {
  try {
    adb("shell","am","start","--user","0","-n",app+"/.MainActivity");
    await connect();
    const beforeRestore=await status();
    const needsRestore=original?.restorePayload && (changedVpn || sessionWasDisturbed(original,beforeRestore,sameConfig(originalConfig,acceptedConfig().raw)));
    if(needsRestore) {
      const old=beforeRestore;
      await invoke("plugin:vpn|start",original.restorePayload);
      await waitRunning(old.since);
    }
    const current=await status();
    const saved=await page.evaluate(()=>({
      settings:localStorage.getItem("singbox-client.settings.v2"),
      manual:localStorage.getItem("singbox-client.manual-profiles.v2"),
      pick:localStorage.getItem("singbox.mobile.lastServer")
    }));
    const restoredOwner=acceptedConfig();
    const fullConfigMatches=restoredOwner.path===configOwner && sameConfig(originalConfig,restoredOwner.raw);
    const restoredConfig=JSON.parse(restoredOwner.raw);
    const originalTun=JSON.parse(originalConfig).inbounds.find(x=>x.type==="tun");
    const restoredTun=restoredConfig.inbounds.find(x=>x.type==="tun");
    const samePolicy=JSON.stringify(originalTun?.include_package||[])===JSON.stringify(restoredTun?.include_package||[]) && JSON.stringify(originalTun?.exclude_package||[])===JSON.stringify(restoredTun?.exclude_package||[]);
    report.restored=fullConfigMatches && samePolicy && current.state===original?.state && current.engine===original?.engine &&
      saved.settings===originalSettings && saved.manual===originalManual && saved.pick===originalPick;
    report.restoreChecks={acceptedConfig:fullConfigMatches,appPolicy:samePolicy,state:current.state===original?.state,engine:current.engine===original?.engine,settings:saved.settings===originalSettings,profiles:saved.manual===originalManual,selection:saved.pick===originalPick};
    if(!report.restored) process.exitCode=1;
  } catch { report.restored=false; process.exitCode=1; }
  try { adb("shell","am","force-stop","--user","0",helper); } catch {}
  if(browser) await browser.close().catch(()=>{});
  for(const owned of ownedPorts) {try{adb("forward","--remove","tcp:"+owned);}catch{process.exitCode=1;report.forwardCleanupFailed=true;}}
  report.finishedAt=new Date().toISOString();
  fs.mkdirSync(path.dirname(args.output),{recursive:true});
  fs.writeFileSync(args.output,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({restored:report.restored,failed:!!process.exitCode}));
}
