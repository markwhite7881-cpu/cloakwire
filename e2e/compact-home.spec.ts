import {test,expect} from "playwright/test";
import {openFixture} from "./fixtures";

test("Android check stays on the server row and does not interrupt the running connection",async({page},info)=>{
 test.skip(info.project.name!=="mobile");
 const {verify}=await openFixture(page,info,{profileProbe:true,running:true,selectedFirst:true,tab:"home"});
 const hero=page.locator(".atlas-connection-panel");
 await expect(hero.getByTestId("profile-probe-button")).toHaveCount(0);
 const card=page.locator(".atlas-server-entry").filter({hasText:"First"}).first();
 await expect(card).toBeVisible();
 // Focus scrolling during the screen's entrance must not leave this clipped hero shifted.
 await hero.evaluate(e=>e.scrollBy({left:48}));
 expect(await hero.evaluate(e=>e.scrollLeft)).toBe(0);
 const check=card.getByRole("button",{name:"Check server",exact:true});
 await check.click();
 await expect(card).toContainText("Server reachable");
 expect(await hero.evaluate(e=>e.scrollLeft)).toBe(0);
 expect(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
 await check.click();
 await expect.poll(()=>page.evaluate(()=>(window as any).probeStarts)).toBe(2);
 await expect(page.locator("canvas").first()).toBeVisible();
 await verify();
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="plugin:vpn|start"||c==="plugin:vpn|stop"))).toEqual([]);
});

test("Android compact check can be cancelled without touching the running VPN",async({page},info)=>{
 test.skip(info.project.name!=="mobile");
 const {verify}=await openFixture(page,info,{locale:"ru",profileProbe:true,running:true,selectedFirst:true,tab:"home"});
 await page.evaluate(()=>{
  const w=window as any,invoke=w.__TAURI_INTERNALS__.invoke;
  w.__TAURI_INTERNALS__.invoke=(cmd:string,args:any)=>cmd==="run_android_profile_probe"
   ?new Promise((resolve,reject)=>{w.releaseProbe=()=>invoke(cmd,args).then(resolve,reject);})
   :invoke(cmd,args);
 });
 const card=page.locator(".atlas-server-entry").filter({hasText:"First"}).first();
 await card.getByRole("button",{name:"Проверить сервер",exact:true}).click();
 await page.evaluate(()=>{document.documentElement.style.zoom="2";});
 expect(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
 await card.getByRole("button",{name:"Отменить проверку",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="plugin:vpn|cancelProbe").length)).toBe(1);
 await page.evaluate(()=>(window as any).releaseProbe());
 await expect(card.getByRole("button",{name:"Проверить сервер",exact:true})).toBeEnabled();
 await expect(page.getByRole("button",{name:"Отключить",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="plugin:vpn|start"||c==="plugin:vpn|stop"))).toEqual([]);
 await verify();
});

test("Android compact failure keeps its explanation and retry available",async({page},info)=>{
 test.skip(info.project.name!=="mobile");
 const {verify}=await openFixture(page,info,{profileProbe:true,running:true,selectedFirst:true,tab:"home"});
 const card=page.locator(".atlas-server-entry").filter({hasText:"First"}).first();
 await card.getByRole("button",{name:"Check server",exact:true}).click();
 await expect(card).toContainText("Server reachable");
 await page.evaluate(()=>{
  const w=window as any;
  w.selectedProbe={...w.selectedProbe,outcome:"failed",issue:"timeout"};
  w.probeListener.onmessage({selected_profile:w.selectedProbe,active_session:null});
 });
 await expect(card).toContainText("did not finish in time");
 await expect(card.getByRole("button",{name:"Check server",exact:true})).toBeEnabled();
 await verify();
});

for(const locale of ["en","ru","zh-CN"])test("compact check wraps localized results at zoom: "+locale,async({page},info)=>{
 const mobile=info.project.name==="mobile";
 await page.setViewportSize(mobile?{width:360,height:844}:{width:1040,height:780});
 const {verify}=await openFixture(page,info,{locale,running:true,selectedFirst:true,tab:"home",...(mobile?{profileProbe:true}:{health:"healthy" as const})});
 const card=page.locator(".atlas-server-entry").filter({hasText:"First"}).first();
 await expect(card).toBeVisible();
 if(mobile){
  await card.getByTestId("profile-probe-button").click();
  await expect(card.getByTestId("profile-health")).toBeVisible();
 }
 expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 if(locale==="en")await page.screenshot({path:info.outputPath("compact-home.png"),fullPage:true});
 await page.evaluate(()=>{document.documentElement.style.zoom="2";});
 expect(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
 const button=card.getByTestId("profile-probe-button");
 await button.focus();await expect(button).toBeFocused();
 const box=await button.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(86);
 await verify();
});
