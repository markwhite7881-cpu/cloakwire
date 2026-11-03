import {test,expect} from "playwright/test";
import {openFixture} from "./fixtures";
test("Atlas sections fit the window and preserve the navigation path",async({page},info)=>{
  const mobile=info.project.name==="mobile";
  const {verify}=await openFixture(page,info,{selectedFirst:true,subscription:true,tab:"servers",locale:"ru",theme:"dark"});
  const dir=process.env.ATLAS_SCREENSHOT_DIR;
  for(const [id,tab] of Object.entries(mobile?{servers:1,routing:2,settings:3}:{servers:1,routing:3,settings:2,logs:4})){
    const nav=mobile?page.locator(".atlas-mobile>nav button"):page.getByRole("tab");
    await nav.nth(tab).click();
    await expect(nav.nth(tab)).toHaveAttribute(mobile?"aria-current":"aria-selected",mobile?"page":"true");
    await expect(page.locator("main")).toBeVisible();
    await page.waitForTimeout(250);
    expect(await page.locator("main").evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    if(!mobile){const rail=await page.locator(".atlas-rail").boundingBox(), body=await page.locator("main").boundingBox();
      expect(rail!.x+rail!.width).toBeLessThanOrEqual(body!.x+1);}
    if(dir)await page.screenshot({path:dir+"/"+info.project.name+"-"+id+".png"});
  }
  if(mobile){
    await page.getByRole("button",{name:/журнал|логи/i}).click();
    await expect(page.locator(".atlas-log-page")).toBeVisible();
    await page.waitForTimeout(300);
    if(dir)await page.screenshot({path:dir+"/mobile-logs.png"});
    await page.getByRole("button",{name:"Back to settings"}).click();
  }
  await verify();
});

test("appearance controls, import menus and the full rule editor remain reachable",async({page},info)=>{
  const mobile=info.project.name==="mobile";
  const {verify}=await openFixture(page,info,{tab:mobile?"settings":"config",selectedFirst:true,theme:"light",locale:"en"});
  const nav=mobile?page.locator(".atlas-mobile>nav button"):page.getByRole("tab");
  const dir=process.env.ATLAS_SCREENSHOT_DIR;
  await expect(page.locator(".atlas-index")).toHaveCount(0);
  await expect(page.getByRole("combobox", {name:"Theme Mode"})).toContainText("Light");
  await nav.nth(1).click();
  if(mobile){
    await page.getByRole("button",{name:"Add Subscription",exact:true}).click();
    const dialog=page.getByRole("dialog");await expect(dialog.locator("textarea")).toBeVisible();
    await dialog.locator("textarea").fill("https://example.invalid/feed");
    if(dir)await page.screenshot({path:dir+"/mobile-import-light.png"});
    await dialog.getByRole("button",{name:"Close sheet"}).click();
    await expect(dialog).toHaveCount(0);
  }else{
    const add=page.locator(".atlas-heading-actions button");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await add.click();
    const input=page.getByRole("dialog").getByRole("textbox");
    await input.fill("https://example.invalid/feed");
    await page.keyboard.press("Escape");
    await expect(add).toBeFocused();
    await expect(input).toHaveCount(0);
    await page.locator(".atlas-heading-actions button").click();
    await expect(input).toHaveValue("https://example.invalid/feed");
    await page.getByRole("dialog").getByRole("button",{name:"Cancel"}).click();
    await nav.nth(3).click();
    await page.locator(".atlas-disclosure>summary").click();
    await expect(page.locator(".atlas-disclosure[open]")).toBeVisible();
    await expect(page.locator(".atlas-disclosure button").first()).toBeVisible();
    if(dir)await page.screenshot({path:dir+"/desktop-expanded-light.png"});
  }
  await verify();
});
