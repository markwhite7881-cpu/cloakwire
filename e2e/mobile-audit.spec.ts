import {expect,test} from "playwright/test";
import {openFixture} from "./fixtures";

test.beforeEach(({},info)=>test.skip(info.project.name!=="mobile"));

test("dismissing a service error removes the card with one tap",async({page},info)=>{
  const {verify}=await openFixture(page,info,{tab:"home",selectedFirst:true,mobileLifecycle:true});
  await page.waitForFunction(()=>!!(window as any).statusListener);
  await page.evaluate(()=>{const w=window as any;w.mobileStatus={...w.mobileStatus,state:"error",message:"engine_unavailable"};w.statusListener.onmessage(w.mobileStatus);});
  const card=page.getByRole("alert");
  await expect(card).toContainText("stopped");await card.getByRole("button",{name:"Close"}).click();
  await expect(card).toHaveCount(0);
  await verify();
});

test("a rejected subscription selection preserves the last server and recent history",async({page},info)=>{
  const {verify}=await openFixture(page,info,{tab:"home",selectedFirst:true,subscription:true,mobileLifecycle:true});
  await expect(page.locator(".atlas-server-trigger")).toContainText("First");
  await page.evaluate(()=>{const w=window as any;const invoke=w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke=(cmd:string,args:any)=>cmd==="set_active_child"?Promise.reject("profile_source_busy"):invoke(cmd,args);});
  await page.locator(".atlas-server-trigger").click();await page.getByRole("button",{name:/Ready server A/}).first().click();
  await expect(page.getByRole("alert")).toContainText("select", {ignoreCase:true});
  await expect(page.locator(".atlas-server-trigger")).toContainText("First");
  await expect(page.locator(".atlas-recent")).not.toContainText("Ready server A");
  await verify();
});

test("a slow accepted bundle selection cannot replace a newer manual choice",async({page},info)=>{
  const {verify}=await openFixture(page,info,{tab:"home",selectedFirst:true,subscription:true,mobileLifecycle:true});
  const selected=page.locator(".atlas-server-trigger");
  await expect(selected).toContainText("First");
  await page.evaluate(()=>{
    const w=window as any, invoke=w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke=(cmd:string,args:any)=>cmd==="set_active_child"
      ? new Promise(resolve=>{w.completeSelection=()=>resolve(invoke(cmd,args));}) : invoke(cmd,args);
  });
  await selected.click();await page.getByRole("dialog").getByRole("button",{name:/Ready server A/}).click();
  await page.waitForFunction(()=>!!(window as any).completeSelection);
  await selected.click();await page.getByRole("dialog").getByRole("button",{name:/Second/}).click();
  await page.evaluate(async()=>{await (window as any).completeSelection();});
  await expect(selected).toContainText("Second");
  await expect(page.locator(".atlas-recent")).not.toContainText("Ready server A");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await verify();
});
