import {test,expect} from "playwright/test";
import {openFixture} from "./fixtures";
test.beforeEach(async({},info)=>{test.skip(info.project.name!=="desktop","Desktop-only implementation stage");});
test("health describes the accepted session and expires without a green claim",async({page},info)=>{
  const {verify}=await openFixture(page,info,{health:"healthy",running:true,tab:"home",selectedFirst:true});
  const card=page.getByTestId("connection-health");
  await expect(page.getByRole("button",{name:"Disconnect",exact:true})).toBeVisible();
  await expect(card).toHaveAttribute("title","Accepted server A");
  await expect.poll(()=>page.evaluate(()=>(window as any).lastTray?.profileName)).toBe("Accepted server A");
  await page.evaluate(()=>{(window as any).fixtureHealth.health.checked_at=new Date(Date.now()-61000).toISOString();});
  await expect(page.getByRole("button",{name:"Disconnect",exact:true})).toBeVisible();
  await expect(card).toContainText("Checked at");
  await verify();
});
test("runtime cause is readable and repeated retry only checks the owning session",async({page},info)=>{
  const {verify}=await openFixture(page,info,{health:"reality",running:true,tab:"home",selectedFirst:true});
  const card=page.getByTestId("connection-health");
  await expect(card).toContainText("could not verify the Reality server");
  await expect(card).not.toContainText("UUID");
  const retry=card.getByRole("button",{name:"Check again",exact:true});
  await retry.evaluate((element:HTMLButtonElement)=>{element.click();element.click();});
  await expect.poll(()=>page.evaluate(()=>(window as any).probeCalls?.length??0)).toBe(1);
  expect(await page.evaluate(()=>(window as any).probeCalls[0].run_id)).toBe("7");
  await expect(card.getByRole("button",{name:"Checking server access…",exact:true})).toBeDisabled();
  await verify();
});
test("old health cannot relabel a new accepted run",async({page},info)=>{
  const {verify}=await openFixture(page,info,{health:"healthy",running:true,tab:"home",selectedFirst:true});
  await expect(page.getByRole("button",{name:"Disconnect",exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const w=window as any;w.fixtureRun="8";
    w.fixtureHealth.session={...w.fixtureHealth.session,run_id:"8",profile_ref:{kind:"manual",id:"b"},profile_revision:"native-b",display_name:"Accepted server B"};
  });
  await expect(page.getByTestId("connection-health")).toHaveAttribute("title","Accepted server B");
  await expect(page.getByRole("button",{name:"Disconnect",exact:true})).toBeVisible();
  await verify();
});

test("connection action stays stable while health changes and the healthy row stays compact",async({page},info)=>{
 const {verify}=await openFixture(page,info,{health:"healthy",running:true,tab:"home",selectedFirst:true});
 const action=page.getByRole("button",{name:"Disconnect",exact:true});
 await expect(action).toBeVisible();
 const card=page.getByTestId("connection-health");
 expect((await card.boundingBox())!.height).toBeLessThanOrEqual(64);
 await card.screenshot({path:".superpowers/sdd/2026-10-31-reliability-and-ux-roadmap/compact-health-preview.png"});
 for(const outcome of ["checking","healthy","unavailable"]){
  await page.evaluate(outcome=>{const h=(window as any).fixtureHealth.health;h.outcome=outcome;h.checked_at=new Date().toISOString();h.issue=outcome==="unavailable"?"probe_target_unavailable":null;},outcome);
  await expect(action).toBeVisible();
 }
 await verify();
});

test("latency probes wait an hour and reuse results after returning Home",async({page},info)=>{
 await page.clock.install();
 const {verify}=await openFixture(page,info,{health:"healthy",running:true,tab:"home",selectedFirst:true});
 const calls=()=>page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="ping_endpoint").length);
 await expect.poll(calls).toBe(1); // Both fixture profiles share one endpoint.
 await page.clock.fastForward(30_000);
 expect(await calls()).toBe(1);
 await page.getByRole("tab",{name:/^Servers/}).click();
 await page.getByRole("tab",{name:/^Home$/}).click();
 await page.clock.fastForward(3_599_000);
 expect(await calls()).toBe(1);
 await page.clock.fastForward(2_000);
 await expect.poll(calls).toBe(2);
 await verify();
});
