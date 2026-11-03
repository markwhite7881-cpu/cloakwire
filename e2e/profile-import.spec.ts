import {test,expect} from "playwright/test";
import assert from "node:assert/strict";
import {openFixture,v2} from "./fixtures";
test("import Cancel, explicit update and storage failure retry",async({page},info)=>{
 const {mobile,verify}=await openFixture(page,info,{single:true});
 await page.waitForFunction(key=>!!localStorage.getItem(key),v2);
    const before=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),v2);
    if(mobile) await page.getByRole('button',{name:'Add Subscription',exact:true}).click();
    if (!mobile) await page.locator(".atlas-heading-actions button").click();
    await page.locator('textarea').first().fill('vless://SYNTHETIC');
    await page.getByRole('button',{name:mobile?'Add':'Add Server',exact:true}).click();
    const dialog=page.getByRole('dialog').filter({hasText:'Compare imported profiles'});
    await dialog.waitFor();
    assert.equal((await dialog.innerText()).includes('NEW_SECRET'),false);
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).records,v2),before.records);
    assert.equal(await page.locator('textarea').first().inputValue(),'vless://SYNTHETIC');
    await page.getByRole('button',{name:mobile?'Add':'Add Server',exact:true}).click();
    await dialog.waitFor();
    await dialog.getByRole('radio',{name:/Update/}).check();
    await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='singbox-client.manual-profiles.v2')throw new Error('quota');window.originalSetItem.call(this,key,value);};});
    await dialog.getByRole('button',{name:'Apply choices'}).click();
    await dialog.getByRole('alert').waitFor();
    assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).records,v2),before.records);

    await page.evaluate(()=>{Storage.prototype.setItem=window.originalSetItem;});
    await dialog.getByRole('button',{name:'Apply choices'}).click();
    await dialog.waitFor({state:'hidden'});
    const after=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),v2);
    assert.equal(after.records.length,1);assert.equal(after.records[0].id,before.records[0].id);
    assert.equal(after.records[0].revision,2);assert.equal(after.records[0].outbound.tag,'My server');
    assert.equal(after.records[0].outbound.uuid,'NEW_SECRET');
    assert.equal((await page.evaluate(()=>window.nativeCalls)).some(x=>x==='start_managed_singbox'||x==='plugin:vpn|start'),false);
    await verify();
});

test("structured parse failure remains readable and preserves input",async({page},info)=>{
 const {mobile,verify}=await openFixture(page,info,{single:true,parseFailure:true});
 if(mobile)await page.getByRole("button",{name:"Add Subscription",exact:true}).click();
 if (!mobile) await page.locator(".atlas-heading-actions button").click();
 await page.locator("textarea").first().fill("vless://SYNTHETIC");
 await page.getByRole("button",{name:mobile?"Add":"Add Server",exact:true}).click();
 await expect(page.getByText(/Invalid port number/).first()).toBeVisible();
 await expect(page.getByText("[object Object]",{exact:true})).toHaveCount(0);
 await expect(page.locator("textarea").first()).toHaveValue("vless://SYNTHETIC");
 expect((await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),v2)).records).toHaveLength(1);
 await verify();
});
