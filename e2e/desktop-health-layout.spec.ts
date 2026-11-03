import {test,expect} from "playwright/test";
import {openFixture} from "./fixtures";
test.beforeEach(async({},info)=>{test.skip(info.project.name!=="desktop","Desktop-only stage");});
const cases=[
  {locale:"ru",theme:"light",accent:"emerald",zoom:1,health:"healthy" as const},
  {locale:"en",theme:"dark",accent:"cyan",zoom:1.25,health:"reality" as const},
  {locale:"zh-CN",theme:"oled",accent:"violet",zoom:1.5,health:"checking" as const},
  {locale:"ru",theme:"system",accent:"amber",zoom:2,health:"reality" as const},
  {locale:"zh-CN",theme:"light",accent:"rose",zoom:1,health:"unavailable" as const},
];
for(const item of cases)test(`health card fits ${item.locale} ${item.theme} ${item.zoom}`,async({page},info)=>{
  await page.setViewportSize({width:1040,height:680});
  await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
  const {verify}=await openFixture(page,info,{...item,running:true,tab:"home",selectedFirst:true});
  const card=page.getByTestId("connection-health");
  await expect(card).toBeVisible();
  await page.evaluate(zoom=>{document.documentElement.style.zoom=String(zoom);},item.zoom);
  await page.evaluate(()=>{(window as any).fixtureHealth.session.display_name="Long accepted server · Длинное название · 很长的服务器名称 ".repeat(3);});
  if(item.health==="healthy"||item.health==="checking")await expect(card).toHaveAttribute("title",/Long accepted server/);
  else await expect(page.locator(".atlas-hero .atlas-active-note")).toContainText("Long accepted server");
  expect(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  const buttons=card.getByRole("button");
  for(const button of await buttons.all()){
    const box=await button.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(43*item.zoom);
  }
  if(item.health!=="checking"){
    await buttons.first().focus();await expect(buttons.first()).toBeFocused();
  }
  await card.screenshot({path:`.superpowers/sdd/2026-10-31-reliability-and-ux-roadmap/health-${item.locale}-${item.theme}.png`});
  await verify();
});
