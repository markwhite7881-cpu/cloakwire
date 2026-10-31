import {test,expect} from "playwright/test";
import {openFixture,records} from "./fixtures";
test("preflight error reconnects its original manual profile and hides refresh",async({page},testInfo)=>{
 await openFixture(page,testInfo,{selectedFirst:true,tab:"home",startError:true});
 const mobile=testInfo.project.name==="mobile";
 const power=page.getByRole("button",{name:/^Connect$/});
 await expect(power).toBeEnabled();await power.click();
 const card=page.getByTestId("profile-error-actions");
 await expect(card.getByRole("button",{name:"Reconnect this server"})).toBeVisible();
 await expect(card.getByRole("button",{name:"Update subscription"})).toHaveCount(0);
 const before=await page.evaluate(()=>(window as any).nativeRequests.filter((r:any)=>r.cmd==="start_managed_singbox"||r.cmd==="plugin:vpn|start").length);
 await card.getByRole("button",{name:"Reconnect this server"}).dblclick();
 await expect.poll(()=>page.evaluate(()=>(window as any).nativeRequests.filter((r:any)=>r.cmd==="start_managed_singbox"||r.cmd==="plugin:vpn|start").length)).toBe(before+1);
 const request=await page.evaluate(()=>(window as any).nativeRequests.filter((r:any)=>r.cmd==="start_managed_singbox"||r.cmd==="plugin:vpn|start").at(-1));
 const first=(await records(page))[0];
 expect(mobile?JSON.parse(request.args.source).profile_ref.id:request.args.input.manualProfileId).toBe(first.id);
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="stop_singbox"||c==="plugin:vpn|stop").length)).toBe(0);
});
test("edited profile cannot reuse the accepted source result",async({page},testInfo)=>{
 test.skip(testInfo.project.name==="mobile");
 await openFixture(page,testInfo,{selectedFirst:true,tab:"home",health:"healthy",boundSource:true});
 await expect(page.getByTestId("profile-health").filter({hasText:"Access verified"}).first()).toBeVisible();
 await page.evaluate(()=>{const key="singbox-client.manual-profiles.v2",store=JSON.parse(localStorage.getItem(key)!);store.records[0].outbound.uuid="changed";store.records[0].revision++;localStorage.setItem(key,JSON.stringify(store));});
 await page.reload();
 await expect(page.getByTestId("profile-health").filter({hasText:"Access verified"})).toHaveCount(0);
 await expect(page.getByTestId("profile-health")).toHaveCount(0);
});

test("subscription refresh invalidates old evidence and reconnect action",async({page},testInfo)=>{
 test.skip(testInfo.project.name==="mobile");
 await openFixture(page,testInfo,{tab:"home",health:"reality",subscription:true});
 await expect.poll(()=>page.evaluate(()=>(window as any).refreshCount)).toBe(1);
 const card=page.getByTestId("profile-error-actions");
 await card.getByRole("button",{name:"Update subscription"}).click();
 await expect(card).toContainText("Subscription updated");
 await card.getByRole("button",{name:"Reconnect this server"}).click();
 await expect(page.getByText("Updated server A",{exact:true}).first()).toBeVisible();
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="start_managed_singbox"||c==="stop_singbox").length)).toBe(0);
});

test("failed card keeps its stopped context after another session starts",async({page},testInfo)=>{
 test.skip(testInfo.project.name==="mobile");
 await openFixture(page,testInfo,{selectedFirst:true,tab:"home",startError:true});
 await page.getByRole("button",{name:/^Connect$/}).click();
 const card=page.getByTestId("profile-error-actions");
 await expect(card.getByRole("button",{name:"Reconnect this server"})).toBeVisible();
 await page.evaluate(()=>{(window as any).statusOverride={status:"running",run_id:"new-run",engine:"singbox",pid:123};});
 await expect(page.getByRole("button",{name:/^Disconnect$/})).toBeVisible();
 await card.getByRole("button",{name:"Reconnect this server"}).click();
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="start_managed_singbox").length)).toBe(1);
 await page.getByRole("tab",{name:/^Home$/}).click();
 await expect(card).toContainText("Choose a server again");
 await page.evaluate(()=>{(window as any).statusOverride={status:"stopped"};});
 await page.getByRole("button",{name:/^Connect$/}).click();
 await expect(card.getByRole("button",{name:"Reconnect this server"})).toBeVisible();
 await expect(card).not.toContainText("Choose a server again");

});

test("mobile ready error refreshes only its subscription and rejects old revision",async({page},info)=>{
 test.skip(info.project.name!=="mobile");
 await openFixture(page,info,{tab:"home",subscription:true,startError:true,selectedFirst:true});
 await expect.poll(()=>page.evaluate(()=>(window as any).refreshCount)).toBe(1);
 await page.getByRole("button",{name:/Provider A/}).first().click();
 await page.getByRole("button",{name:/Ready server A/}).first().click();
 await page.getByRole("button",{name:/^Connect$/}).click();
 const card=page.getByTestId("profile-error-actions");
 await card.getByRole("button",{name:"Update subscription"}).click();
 await expect(card).toContainText("Subscription updated");
 await card.getByRole("button",{name:"Reconnect this server"}).click();
 await page.getByRole("button",{name:/Provider A/}).first().click();
 await expect(page.getByText("Updated server A",{exact:true}).first()).toBeVisible();
 const requests=await page.evaluate(()=>(window as any).nativeRequests);
 expect(requests.filter((r:any)=>r.cmd==="refresh_subscription").every((r:any)=>r.args.id==="sub-a")).toBe(true);
 expect(requests.filter((r:any)=>r.cmd==="plugin:vpn|start")).toHaveLength(1);
 expect(requests.filter((r:any)=>r.cmd==="plugin:vpn|stop")).toHaveLength(0);
});
for(const locale of ["ru","en","zh-CN"])test("error actions fit "+locale,async({page},info)=>{
 await openFixture(page,info,{tab:"home",single:true,startError:true,locale});
 await page.getByRole("button",{name:/^(Connect|Подключить|Подключиться|连接)$/}).click();
 const card=page.getByTestId("profile-error-actions");await expect(card).toBeVisible();
 expect(await card.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 const button=card.getByRole("button").first();await button.focus();await expect(button).toBeFocused();
 expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 await card.screenshot({path:".superpowers/sdd/2026-10-31-reliability-and-ux-roadmap/actions-"+info.project.name+"-"+locale+".png"});
});
