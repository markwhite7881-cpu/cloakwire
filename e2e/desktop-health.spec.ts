import {test,expect} from "playwright/test";
import {openFixture} from "./fixtures";
test.beforeEach(async({},info)=>{test.skip(info.project.name!=="desktop","Desktop-only implementation stage");});
test("health describes the accepted session and expires without a green claim",async({page},info)=>{
  const {verify}=await openFixture(page,info,{health:"healthy",running:true,tab:"home",selectedFirst:true});
  const card=page.getByTestId("connection-health");
  await expect(page.getByRole("heading",{name:"Server connection verified"})).toBeVisible();
  await expect(card).toContainText("Session: Accepted server A");
  await expect.poll(()=>page.evaluate(()=>(window as any).lastTray?.profileName)).toBe("Accepted server A");
  await page.evaluate(()=>{(window as any).fixtureHealth.health.checked_at=new Date(Date.now()-61000).toISOString();});
  await expect(page.getByRole("heading",{name:"VPN is running",exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Server connection verified"})).toBeHidden();
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
  await expect(page.getByRole("heading",{name:"Server connection verified"})).toBeVisible();
  await page.evaluate(()=>{
    const w=window as any;w.fixtureRun="8";
    w.fixtureHealth.session={...w.fixtureHealth.session,run_id:"8",profile_ref:{kind:"manual",id:"b"},profile_revision:"native-b",display_name:"Accepted server B"};
  });
  await expect(page.getByTestId("connection-health")).toContainText("Session: Accepted server B");
  await expect(page.getByRole("heading",{name:"VPN is running",exact:true})).toBeVisible();
  await verify();
});
