import {describe,expect,it} from "vitest";
import {RecoverySettings,RECOVERY_KEY,readRecoveryPreference} from "./recoverySettings";

function storage(value:string|null=null){
 const data=new Map<string,string>();if(value!==null)data.set(RECOVERY_KEY,value);
 return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}};
}
describe("recovery preference",()=>{
 it("is disabled for legacy, missing, malformed and non-boolean values",()=>{
  for(const value of [null,"1","yes","null","{}","false",'"true"'])expect(readRecoveryPreference(storage(value))).toBe(false);
  expect(readRecoveryPreference(storage("true"))).toBe(true);
  expect(readRecoveryPreference({getItem:()=>{throw Error("denied")}})).toBe(false);
 });
 it("initializes once and does not infer connection intent from enabled preference",async()=>{
  const calls:boolean[]=[],controller=new RecoverySettings(storage("true"),async enabled=>{calls.push(enabled)});
  await Promise.all([controller.initialize(),controller.initialize()]);
  expect(calls).toEqual([true]);expect(controller.snapshot()).toMatchObject({enabled:true,busy:false,issue:null});
 });
 it("persists explicit enable only after native acknowledgement",async()=>{
  const store=storage(),calls:boolean[]=[],controller=new RecoverySettings(store,async enabled=>{calls.push(enabled)});
  await controller.initialize();await controller.setEnabled(true);
  expect(calls).toEqual([false,true]);expect(store.getItem(RECOVERY_KEY)).toBe("true");expect(controller.snapshot().enabled).toBe(true);
 });
 it("keeps disabled after native enable failure",async()=>{
  const store=storage(),controller=new RecoverySettings(store,async enabled=>{if(enabled)throw Error("native unavailable")});
  await controller.initialize();await controller.setEnabled(true);
  expect(controller.snapshot()).toMatchObject({enabled:false,busy:false,issue:"apply"});expect(readRecoveryPreference(store)).toBe(false);
 });
 it("a failed disable is not falsely displayed as disabled and next launch remains off",async()=>{
  const store=storage("true");let fail=false;
  const controller=new RecoverySettings(store,async enabled=>{if(fail&&!enabled)throw Error("native unavailable")});
  await controller.initialize();fail=true;await controller.setEnabled(false);
  expect(controller.snapshot()).toMatchObject({enabled:true,issue:"apply"});expect(readRecoveryPreference(store)).toBe(false);
 });
 it("never enables recovery if saving the preference fails",async()=>{
  const calls:boolean[]=[],store={...storage(),setItem:()=>{throw Error("quota")}},controller=new RecoverySettings(store,async enabled=>{calls.push(enabled)});
  await controller.initialize();await controller.setEnabled(true);
  expect(calls).toEqual([false]);expect(controller.snapshot()).toMatchObject({enabled:false,issue:"save"});
 });
 it("still cancels native recovery when saving disable fails",async()=>{
  const calls:boolean[]=[],store={...storage("true"),setItem:()=>{throw Error("quota")}},controller=new RecoverySettings(store,async enabled=>{calls.push(enabled)});
  await controller.initialize();await controller.setEnabled(false);
  expect(calls).toEqual([true,false]);expect(controller.snapshot()).toMatchObject({enabled:false,issue:"save"});
 });
 it("coalesces repeated changes while native acknowledgement is pending",async()=>{
  let finish:()=>void=()=>{};const calls:boolean[]=[],controller=new RecoverySettings(storage(),enabled=>{calls.push(enabled);return enabled?new Promise<void>(r=>{finish=r}):Promise.resolve()});
  await controller.initialize();const first=controller.setEnabled(true);await controller.setEnabled(true);
  expect(calls).toEqual([false,true]);expect(controller.snapshot().busy).toBe(true);
  finish();await first;expect(controller.snapshot()).toMatchObject({enabled:true,busy:false});
 });
 for(const rollbackFails of [false,true]){
  it("reports final persistence failure with "+(rollbackFails?"failed":"successful")+" native rollback",async()=>{
   const values=storage(),calls:boolean[]=[];
   const store={...values,setItem:(key:string,value:string)=>{if(value==="true")throw Error("quota");values.setItem(key,value)}};
   let enabledOnce=false;
   const controller=new RecoverySettings(store,async enabled=>{
    calls.push(enabled);
    if(enabled)enabledOnce=true;
    else if(enabledOnce&&rollbackFails)throw Error("native unavailable");
   });
   await controller.initialize();await controller.setEnabled(true);
   expect(calls).toEqual([false,true,false]);
   expect(controller.snapshot()).toMatchObject({enabled:rollbackFails,issue:"save",busy:false});
   expect(readRecoveryPreference(values)).toBe(false);
  });
 }

});
