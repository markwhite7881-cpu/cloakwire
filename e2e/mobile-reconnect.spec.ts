import {test,expect} from "playwright/test";
import {openFixture,records} from "./fixtures";
test.beforeEach(async({},info)=>test.skip(info.project.name!=="mobile"));
async function pickSecond(page:import("playwright/test").Page){
 await page.getByRole("button",{name:/First/}).first().click();
 await page.getByRole("dialog").getByRole("button",{name:/Second/}).click();
}
test("one reconnect click replaces the accepted manual session without stopping before validation",async({page},info)=>{
 await openFixture(page,info,{mobileLifecycle:true,running:true,selectedFirst:true,tab:"home"});
 await pickSecond(page);
 await page.getByRole("button",{name:"Reconnect now",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).mobileStatus?.profile_name)).toBe("Second");
 const requests=await page.evaluate(()=>(window as any).nativeRequests);
 const starts=requests.filter((r:any)=>r.cmd==="plugin:vpn|start");
 expect(starts).toHaveLength(1);
 expect(starts[0].args.expectedRunId).toBe("run-a");
 expect(JSON.parse(starts[0].args.source).profile_ref.id).toBe((await records(page))[1].id);
 expect(requests.filter((r:any)=>r.cmd==="plugin:vpn|stop"||r.cmd==="plugin:vpn|probe")).toEqual([]);
 await expect(page.getByRole("alert")).toHaveCount(0);
 await expect(page.getByRole("button",{name:"Reconnect now",exact:true})).toHaveCount(0);
});
test("an invalid replacement keeps the current VPN available",async({page},info)=>{
 await openFixture(page,info,{mobileLifecycle:true,running:true,selectedFirst:true,tab:"home",startError:true});
 await pickSecond(page);
 await page.getByRole("button",{name:"Reconnect now",exact:true}).click();
 await expect(page.getByRole("alert")).toBeVisible();
 expect(await page.evaluate(()=>(window as any).mobileStatus)).toMatchObject({state:"running",run_id:"run-a",profile_name:"First"});
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="plugin:vpn|stop"))).toEqual([]);
});

for(const failure of ["generate","permission"] as const){
 test("failed "+failure+" releases only its own native preparation without stopping the VPN",async({page},info)=>{
  await openFixture(page,info,{mobileLifecycle:true,running:true,selectedFirst:true,tab:"home",preparationFailure:failure});
  await pickSecond(page);await page.getByRole("button",{name:"Reconnect now",exact:true}).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button",{name:"Retry",exact:true})).toBeEnabled();
  await expect.poll(()=>page.evaluate(()=>(window as any).nativeRequests.filter((r:any)=>r.cmd==="plugin:vpn|cancelProfilePreparation").map((r:any)=>r.args.preparationId))).toEqual(["1"]);
  expect(await page.evaluate(()=>(window as any).mobileStatus)).toMatchObject({state:"running",run_id:"run-a",profile_name:"First"});
  expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:string)=>c==="plugin:vpn|stop"||c==="plugin:vpn|start"))).toEqual([]);
 });
}

test("cancelled replacement keeps the pending choice until a later accepted retry",async({page},info)=>{
 await openFixture(page,info,{mobileLifecycle:true,running:true,selectedFirst:true,tab:"home"});
 await pickSecond(page);
 await page.evaluate(()=>{
  const w=window as any,original=w.__TAURI_INTERNALS__.invoke;
  let cancel=true;
  w.__TAURI_INTERNALS__.invoke=async(cmd:string,args:any)=>{
   if(cmd==="plugin:vpn|start"&&cancel){cancel=false;w.cancelledReplacement=true;throw "profile_check_cancelled";}
   return original(cmd,args);
  };
 });
 const reconnect=page.getByRole("button",{name:"Reconnect now",exact:true});
 await reconnect.click();
 await page.waitForFunction(()=>(window as any).cancelledReplacement===true);
 await expect(reconnect).toBeEnabled();
 await expect(page.getByRole("alert")).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).mobileStatus)).toMatchObject({state:"running",run_id:"run-a",profile_name:"First"});
 await reconnect.click();
 await expect.poll(()=>page.evaluate(()=>(window as any).mobileStatus?.profile_name)).toBe("Second");
 await expect(reconnect).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).nativeCalls.filter((cmd:string)=>cmd==="plugin:vpn|stop"))).toEqual([]);
});
