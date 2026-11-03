import { expect, test } from "playwright/test";
import { openFixture } from "./fixtures";

test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop"); });

test("the idle globe rotates and appearance choices survive a tab change and reload", async ({ page }, info) => {
  const { verify } = await openFixture(page, info, { tab:"home", selectedFirst:true, theme:"dark" });
  const globe = page.locator(".atlas-scene canvas");
  await expect(globe).toBeVisible();
  const center = await globe.getAttribute("data-center");
  await expect.poll(() => globe.getAttribute("data-center")).not.toBe(center);
  await expect(page.locator("header [role=tab]")).toHaveCount(5);
  await page.screenshot({path:info.outputPath("home-dark.png")});
  await page.getByRole("tab").nth(2).click();
  await page.getByRole("button", {name:"Light",exact:true}).click();
  await page.getByRole("button", {name:"Русский",exact:true}).click();
  await expect(page.getByRole("button",{name:"Русский",exact:true})).toHaveAttribute("aria-pressed","true");
  await page.reload();
  await expect(page.getByRole("button",{name:"Русский",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("tab").nth(0).click();
  await expect(page.locator(".atlas-scene canvas")).toBeVisible();
  await page.getByRole("button",{name:"Редактировать",exact:true}).click();
  await expect(page.getByRole("tab").nth(3)).toHaveAttribute("aria-selected","true");
  await verify();
});

test("the speed test borrows the live chart and restores it after cancel and completion", async ({page},info)=>{
  const {verify}=await openFixture(page,info,{tab:"home",selectedFirst:true});
  const card=page.locator(".atlas-traffic");
  let delayed=true;
  await page.route("https://speed.cloudflare.com/**",async route=>{
    if(delayed) await new Promise(resolve=>setTimeout(resolve,350));
    await route.fulfill({status:200,body:Buffer.alloc(route.request().url().includes("bytes=0")?0:65536)}).catch(()=>{});
  });
  await card.getByRole("button",{name:"Speed Test",exact:true}).click();
  await card.getByRole("button",{name:"Stop Test",exact:true}).click();
  await expect(card.getByRole("button",{name:"Speed Test",exact:true})).toBeVisible();
  delayed=false;
  await card.getByRole("button",{name:"Speed Test",exact:true}).click();
  await expect(card.getByRole("status")).toContainText("Mbps");
  await expect(card.getByRole("button",{name:"Speed Test",exact:true})).toBeVisible();
  await card.locator("summary").click();
  await expect(card.getByRole("button",{name:"Clear History",exact:true})).toBeVisible();
  await verify();
});

test("the accepted country stays in focus with an eight-second pulse and follows a server change", async({page},info)=>{
  const {verify}=await openFixture(page,info,{tab:"home",running:true,selectedFirst:true,theme:"dark"});
  await page.evaluate(()=>{
    const w=window as any, native=w.__TAURI_INTERNALS__.invoke;
    w.atlasChoice="🇯🇵 Tokyo";
    w.__TAURI_INTERNALS__.invoke=(cmd:string,args:unknown)=>cmd==="list_proxies"?
      Promise.resolve({proxies:{proxy:{now:w.atlasChoice}}}):native(cmd,args);
  });
  const scene=page.locator(".atlas-scene");
  await expect(scene.locator(".ah-label")).toHaveText("Japan");
  await expect(scene).toHaveAttribute("data-effect",/contour|wave/);
  const camera=await scene.locator("canvas").getAttribute("data-center");
  await expect(scene.locator(".ah-line-pulse")).toHaveCSS("animation-duration","8s");
  await page.waitForTimeout(200);
  expect(await scene.locator("canvas").getAttribute("data-center")).toBe(camera);
  await page.evaluate(()=>{(window as any).atlasChoice="🇦🇺 Sydney";});
  await expect(scene.locator(".ah-label")).toHaveText("Australia");
  await expect(scene).toHaveAttribute("data-effect",/contour|wave/);
  expect(await scene.locator("canvas").getAttribute("data-center")).not.toBe(camera);
  await verify();
});

test("profile and subscription text travel through the same importer",async({page},info)=>{
  const {verify}=await openFixture(page,info,{tab:"servers",selectedFirst:true});
  await page.evaluate(()=>{
    const w=window as any,native=w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke=async(cmd:string,args:any)=>{
      if(cmd==="parse_input"){
        w.atlasImport=args.text;
        return {outbounds:[{protocol:"vless",tag:"Atlas UK",server:"example.test",port:443,uuid:"fixture-only",transport:{kind:"tcp"},tls:{enabled:false,alpn:[],allow_insecure:false}}],subscriptions:["https://provider.example/test"],failures:[]};
      }
      if(cmd==="add_subscription"){w.atlasSub=args.input.url;return {selection_changed:false};}
      return native(cmd,args);
    };
  });
  const mixed="vless://fixture-only@example.test:443#AtlasUK\nhttps://provider.example/test";
  await page.locator("textarea").first().fill(mixed);
  await page.getByRole("button",{name:"Add Server",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).atlasImport)).toBe(mixed);
  await expect.poll(()=>page.evaluate(()=>(window as any).atlasSub)).toBe("https://provider.example/test");
  await expect(page.locator("textarea").first()).toHaveValue("");
  await verify();
});
