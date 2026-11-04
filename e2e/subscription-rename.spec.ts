import {test, expect} from "playwright/test";
import {openFixture} from "./fixtures";

test("renaming an existing subscription keeps the draft after a write failure",async({page},info)=>{
  test.skip(info.project.name!=="desktop");
  const {verify}=await openFixture(page,info,{subscription:true,tab:"servers"});
  await page.evaluate(()=>{
    const w=window as any, invoke=w.__TAURI_INTERNALS__.invoke;
    let attempts=0;
    w.__TAURI_INTERNALS__.invoke=(cmd:string,args:any)=>{
      if(cmd!=="rename_subscription") return invoke(cmd,args);
      ++attempts;
      return attempts===1 ? Promise.reject("write failed") : Promise.resolve({id:args.id,name:args.name});
    };
  });
  const row=page.locator(".atlas-subscription-row");
  await row.getByTitle("Rename subscription").click();
  const input=row.getByRole("textbox");
  await input.fill("Work VPN");
  await row.getByRole("button",{name:"Save"}).click();
  await expect(row.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("Work VPN");
  await expect(row).toContainText("Provider A");
  await row.getByRole("button",{name:"Save"}).click();
  await expect(input).toHaveCount(0);
  await expect(row).toContainText("Work VPN");
  await expect(row).toContainText("Ready server A");
  await verify();
});
