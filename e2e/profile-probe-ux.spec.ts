import {test,expect} from "playwright/test";
import {openFixture} from "./fixtures";
test.beforeEach(async({},info)=>test.skip(info.project.name!=="mobile"));
test("switching servers retains their measurements without starting checks",async({page},info)=>{
 await page.clock.install();
 await openFixture(page,info,{profileProbe:true,selectedFirst:true,tab:"home",running:true});
 const card=page.getByTestId("profile-probe-card"),button=page.getByTestId("profile-probe-button");
 await expect(button).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).probeStarts??0)).toBe(0);
 await button.click();await expect(card).toContainText("Access verified");
 await page.getByRole("button",{name:/First/}).first().click();
 await page.getByRole("dialog").getByRole("button",{name:/Second/}).click();
 await expect(card.getByTestId("profile-health")).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).probeStarts)).toBe(1);
 await button.click();await expect(card).toContainText("Access verified");
 await page.getByRole("button",{name:/Second/}).first().click();
 await page.getByRole("dialog").getByRole("button",{name:/First/}).click();
 await expect(card).toContainText("Last check: reachable");
 await page.clock.fastForward(65000);
 await expect(card).toContainText("Last check: reachable");
 await expect(card).not.toContainText("Check expired");
 expect(await page.evaluate(()=>(window as any).probeStarts)).toBe(2);
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="plugin:vpn|start"||c==="plugin:vpn|stop"))).toEqual([]);
});
test("unavailable background snapshots do not show an unsolicited check error",async({page},info)=>{
 await openFixture(page,info,{selectedFirst:true,tab:"home"});
 const card=page.getByTestId("profile-probe-card");
 await expect(card).toBeVisible();
 await expect(card).not.toContainText("Could not check");
 await expect(card.getByTestId("profile-health")).toHaveCount(0);
 await expect(card.locator("details")).toHaveCount(0);
});

test("a snapshot for another server cannot become the selected server error",async({page},info)=>{
 await openFixture(page,info,{profileProbe:true,staleProbe:true,selectedFirst:true,tab:"home"});
 const card=page.getByTestId("profile-probe-card");
 await expect(card).toBeVisible();
 await expect(card.locator("details")).toHaveCount(0);
 await expect(card.getByTestId("profile-health")).toHaveCount(0);
});

test("late source loading and Auto cannot resurrect another profile error",async({page},info)=>{
 await openFixture(page,info,{profileProbe:true,staleProbe:true,revisionDelay:1000,selectedFirst:true,tab:"home"});
 const card=page.getByTestId("profile-probe-card");
 await expect(page.getByTestId("profile-probe-button")).toBeEnabled();
 await page.getByRole("button",{name:/First/}).first().click();
 await page.getByRole("dialog").getByRole("button",{name:/Auto/}).click();
 await expect(page.getByTestId("profile-probe-button")).toBeDisabled();
 await expect(card.locator("details")).toHaveCount(0);
});
