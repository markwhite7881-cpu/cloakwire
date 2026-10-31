import {test,expect} from "playwright/test";
import {openFixture,records,v1,v2} from "./fixtures";
test("same-name candidates share distinct safe labels with server rows",async({page},info)=>{
 const {mobile,verify}=await openFixture(page,info);
 await page.waitForFunction(key=>!!localStorage.getItem(key),v2);
 const before=await records(page),hints=before.map((r:any)=>"#"+r.id.slice(0,8));
 for(const hint of hints)await expect(page.getByText(hint,{exact:true})).toBeVisible();
 if(mobile)await page.getByRole("button",{name:"Add Subscription",exact:true}).click();
 await page.locator("textarea").first().fill("vless://SYNTHETIC");
 await page.getByRole("button",{name:mobile?"Add":"Add Server",exact:true}).click();
 const dialog=page.getByRole("dialog").filter({hasText:"Compare imported profiles"});
 for(const hint of hints)await expect(dialog.getByRole("radio",{name:new RegExp(hint)})).toBeVisible();
 expect(await dialog.innerText()).not.toContain("NEW_SECRET");
 await dialog.getByRole("button",{name:"Cancel",exact:true}).click();await verify();
});
test("deleting the selected profile requires a choice, including after reload",async({page},info)=>{
 const {mobile,verify}=await openFixture(page,info,{selectedFirst:true});
 await page.waitForFunction(key=>!!localStorage.getItem(key),v2);
 if(mobile){
   await page.getByRole("button",{name:"Delete First",exact:true}).click();
   await page.getByRole("button",{name:"Delete",exact:true}).click();
 }else{
   page.on("dialog",dialog=>dialog.accept());
   await page.getByRole("button",{name:"Delete",exact:true}).first().click();
 }
 const warning=page.getByText("The saved server selection could not be restored unambiguously.",{exact:false}).first();
 await expect(warning).toBeVisible();
 expect(await records(page)).toHaveLength(1);
 await page.reload();await expect(warning).toBeVisible();await verify();
});
test("retry after quota failure cannot overwrite a newer stored collection",async({page},info)=>{
 const {mobile,verify}=await openFixture(page,info,{single:true});
 await page.waitForFunction(key=>!!localStorage.getItem(key),v2);
 if(mobile)await page.getByRole("button",{name:"Add Subscription",exact:true}).click();
 await page.locator("textarea").first().fill("vless://SYNTHETIC");
 await page.getByRole("button",{name:mobile?"Add":"Add Server",exact:true}).click();
 const dialog=page.getByRole("dialog").filter({hasText:"Compare imported profiles"});
 await dialog.getByRole("radio",{name:/Update/}).check();
 await page.evaluate(()=>{const w=window as any;w.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==="singbox-client.manual-profiles.v2")throw Error("quota");w.originalSetItem.call(this,key,value);};});
 await dialog.getByRole("button",{name:"Apply choices"}).click();
 await expect(dialog.getByRole("alert")).toBeVisible();await dialog.getByRole("button",{name:"Cancel",exact:true}).click();
 if(mobile)await page.keyboard.press("Escape");
 await page.evaluate(key=>{Storage.prototype.setItem=(window as any).originalSetItem;const current=JSON.parse(localStorage.getItem(key)!);current.records[0].revision++;current.records[0].outbound.uuid="LATEST_FIXTURE";localStorage.setItem(key,JSON.stringify(current));},v2);
 await page.getByRole("button",{name:"Retry saving",exact:true}).click();
 expect((await records(page))[0].outbound.uuid).toBe("LATEST_FIXTURE");await verify();
});
