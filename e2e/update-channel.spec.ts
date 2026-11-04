import {test, expect} from "playwright/test";
import {openFixture} from "./fixtures";

test.beforeEach(({},info)=>test.skip(info.project.name !== "desktop"));

for (const preview of [true,false]) {
  test(preview ? "Preview only offers manual updates" : "stable updater pins the version shown to the user", async({page}, info) => {
    await openFixture(page,info,{tab:"home"});
    await page.evaluate(preview=>{
      const w=window as any, invoke=w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke=(cmd:string,args:unknown)=>{
        if(cmd==="check_app_update")return Promise.resolve({
          manual_only:preview, available:!preview, current_version:"1.4.11",version:"1.4.12",notes:"",
        });
        if(cmd==="install_app_update"){w.installRequested=args;return Promise.resolve();}
        return invoke(cmd,args);
      };
      sessionStorage.setItem("cloakwire:dismissed_update:1.4.12","1");
    },preview);
    await page.getByRole("tab",{name:"Settings",exact:true}).click();
    const updates=page.locator(".atlas-updates");
    if(preview){
      await expect(updates).toContainText("Install Atlas Preview updates manually");
      await expect(updates.getByRole("button")).toHaveCount(0);
    }else{
      await updates.getByRole("button",{name:"Update & restart"}).click();
      expect(await page.evaluate(()=>(window as any).installRequested)).toEqual({expectedVersion:"1.4.12"});
    }
  });
}
