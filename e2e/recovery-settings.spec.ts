import {test,expect} from "playwright/test";
import {openFixture} from "./fixtures";

test("recovery is opt-in and changing it preserves the accepted VPN and profile settings",async({page},info)=>{
 const mobile=info.project.name==="mobile";
 await openFixture(page,info,{running:true,selectedFirst:true,tab:mobile?"settings":"config"});
 const control=page.getByRole("switch",{name:"Automatic VPN recovery",exact:true});
 await expect(control).toBeVisible({timeout:2500});await expect(control).toBeEnabled();
 await expect(control).not.toBeChecked();
 const before=await page.evaluate(()=>localStorage.getItem("singbox-client.settings.v2"));
 await control.click();await expect(control).toBeChecked();
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem("cloakwire.recovery.enabled.v1"))).toBe("true");
 await control.click();await expect(control).not.toBeChecked();
 const command=mobile?"plugin:vpn|setRecoveryEnabled":"set_recovery_enabled";
 expect(await page.evaluate(command=>(window as any).nativeRequests.filter((r:any)=>r.cmd===command).map((r:any)=>r.args.enabled),command)).toEqual([false,true,false]);
 expect(await page.evaluate(()=>localStorage.getItem("singbox-client.settings.v2"))).toBe(before);
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>["plugin:vpn|start","plugin:vpn|stop","start_managed_singbox","stop_connection","plugin:vpn|probe","retry_active_probe"].includes(c)))).toEqual([]);
 await page.reload();await expect(control).toBeEnabled();await expect(control).not.toBeChecked();
});

test("background checking stays quiet and the UI only reads native recovery state",async({page},info)=>{
 await openFixture(page,info,{running:true,selectedFirst:true,tab:"home",recoveryEnabled:true,recoveryPhase:"checking"});
 const notice=page.getByTestId("recovery-notice");
 await expect.poll(()=>page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="get_recovery_status"||c==="plugin:vpn|recoveryStatus").length)).toBeGreaterThan(0);
 await expect(notice).toHaveCount(0);
 await page.evaluate(()=>{(window as any).recoveryPhase="recovering"});
 await expect(notice).toContainText("Restoring the VPN connection");
 await page.evaluate(()=>{(window as any).recoveryPhase="idle"});
 await expect(notice).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>["plugin:vpn|start","plugin:vpn|stop","start_managed_singbox","stop_connection","plugin:vpn|probe","retry_active_probe"].includes(c)))).toEqual([]);
});

test("a rejected preference change stays off and shows one inline explanation",async({page},info)=>{
 await openFixture(page,info,{tab:info.project.name==="mobile"?"settings":"config",recoveryError:true});
 const control=page.getByRole("switch",{name:"Automatic VPN recovery",exact:true});
 await expect(control).toBeEnabled();await control.click();
 await expect(page.getByTestId("recovery-setting").getByRole("alert")).toHaveText("Could not apply this setting. Try again.");
 await expect(control).not.toBeChecked();
 expect(await page.evaluate(()=>localStorage.getItem("cloakwire.recovery.enabled.v1"))).toBe("false");
});

for(const [issue,explanation] of [
 ["authentication","Check the server credentials before connecting again."],
 ["permission_required","VPN recovery needs your permission. Connect manually."],
]){
 test("terminal recovery explains "+issue+" instead of suggesting blind retries",async({page},info)=>{
  await openFixture(page,info,{running:true,selectedFirst:true,tab:"home",recoveryEnabled:true,recoveryPhase:"exhausted",recoveryIssue:issue});
  await expect(page.getByTestId("recovery-notice")).toHaveText(explanation,{timeout:3000});
 });
}

test("an unsupported connection explains the recovery limit inside settings",async({page},info)=>{
 await openFixture(page,info,{running:true,selectedFirst:true,tab:info.project.name==="mobile"?"settings":"config",recoveryEnabled:true,recoveryPhase:"unavailable",recoveryIssue:"unsupported_probe"});
 await expect(page.getByTestId("recovery-setting")).toContainText("Automatic network recovery is unavailable for this connection.",{timeout:3000});
});
