import {test,expect} from "playwright/test";
import {openFixture,records,v1,v2} from "./fixtures";
test("migration and downgrade reconciliation preserve record ownership",async({page},info)=>{
  const {verify}=await openFixture(page,info);
  await expect(page.getByText("The saved server selection could not be restored unambiguously.",{exact:false}).first()).toBeVisible();
  const before=await records(page);
  expect(before).toHaveLength(2);expect(before[0].id).not.toBe(before[1].id);
  await page.reload();
  await expect(page.getByText("The saved server selection could not be restored unambiguously.",{exact:false}).first()).toBeVisible();
  expect((await records(page)).map((r:any)=>r.id)).toEqual(before.map((r:any)=>r.id));
  await page.evaluate(key=>{const old=JSON.parse(localStorage.getItem(key)!);old.push({...old[0],tag:"Old app change",uuid:"third"});localStorage.setItem(key,JSON.stringify(old));},v1);
  await page.reload();
  await page.getByRole("button",{name:"Combine both collections"}).click();
  await expect(page.getByText("Profiles were edited in an older app version.",{exact:false})).toBeHidden();
  const merged=await records(page);
  expect(merged).toHaveLength(3);expect(merged.slice(0,2)).toEqual(before);
  await verify();
});
