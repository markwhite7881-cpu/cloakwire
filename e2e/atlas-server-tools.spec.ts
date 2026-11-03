import { test, expect } from "playwright/test";
import { openFixture } from "./fixtures";

test("a card checks its own inactive profile without selecting or connecting it", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const { verify } = await openFixture(page, info, {
    tab:"home", running:true, selectedFirst:true, profileProbe:mobile, mobileLifecycle:mobile,
    ...(mobile ? {} : {health:"healthy" as const, boundSource:true}),
  });
  const hero = page.locator(mobile ? ".atlas-connection-panel" : ".atlas-hero");
  const rows = page.locator(".atlas-server-entry");
  const second = rows.filter({hasText:"Second"}).first();
  await expect(hero.getByTestId("profile-probe-button")).toHaveCount(0);
  await expect(page.locator(".atlas-recent").getByTestId("profile-probe-button")).toHaveCount(0);
  await second.getByRole("button",{name:"Check server",exact:true}).click();
  await expect(second).toContainText("Access verified");
  await expect(hero.locator(".atlas-server-trigger")).toContainText("First");
  const calls = await page.evaluate(() => (window as any).nativeRequests);
  const checks = calls.filter((r:any) => r.cmd === (mobile ? "run_android_profile_probe" : "probe_desktop_profile"));
  expect(checks).toHaveLength(1);
  expect(checks[0].args.outbound.tag).toBe("Second");
  expect(calls.filter((r:any)=>["plugin:vpn|start","plugin:vpn|stop","start_managed_singbox","stop_connection","retry_active_probe"].includes(r.cmd))).toHaveLength(0);
  const nav = mobile ? page.locator(".atlas-bottom-nav button") : page.getByRole("tab");
  await nav.nth(1).click();
  const directory = page.locator(mobile ? ".atlas-server-entry" : ".atlas-profile-row").filter({hasText:"Second"}).first();
  await expect(directory.getByTestId("profile-probe-button")).toBeEnabled();
  await expect(directory).toContainText("Access verified");
  await verify();
});

test("home order, mode controls and mobile recent latency", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await openFixture(page, info, {tab:"home", selectedFirst:true, fixturePingMs:17, locale:"ru", accent:"emerald", theme:"dark"});
  const traffic = page.locator(".atlas-traffic");
  const routing = mobile ? page.locator("main .atlas-home-section").first() : page.locator(".atlas-route-summary");
  const trafficBox = (await traffic.boundingBox())!, routingBox = (await routing.boundingBox())!;
  expect(trafficBox.y + trafficBox.height).toBeLessThanOrEqual(routingBox.y + 1);
  if (!mobile) {
    const hero = page.locator(".atlas-hero");
    expect((await hero.locator(".atlas-home-modes").boundingBox())!.y)
      .toBeGreaterThanOrEqual((await hero.locator(".atlas-power").boundingBox())!.y + (await hero.locator(".atlas-power").boundingBox())!.height);
  } else {
    await expect(page.locator(".atlas-recent .atlas-pick-row").first()).toContainText("17ms");
  }
  if(process.env.ATLAS_UI7_SHOTS) await page.screenshot({animations:"disabled",path:process.env.ATLAS_UI7_SHOTS+"/"+info.project.name+"-home.png"});
});

test("Russian routing labels wrap only at spaces on narrow Android screens", async ({page}, info) => {
  test.skip(info.project.name !== "mobile");
  await openFixture(page, info, {tab:"routing", locale:"ru", theme:"dark", selectedFirst:true});
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({width, height:820});
    const broken = await page.locator(".atlas-routing .atlas-mode-selector button, .atlas-bottom-item").evaluateAll(elements => {
      const words: string[] = [];
      for (const element of elements) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          for (const match of (node.textContent ?? "").matchAll(/[А-Яа-яЁё]+/g)) {
            const range = document.createRange();
            range.setStart(node, match.index!); range.setEnd(node, match.index! + match[0].length);
            if (range.getClientRects().length > 1) words.push(match[0]);
          }
        }
      }
      return words;
    });
    await expect(page.locator(".atlas-mode-selector").first()).toBeVisible();
    expect(broken).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if(width===320 && process.env.ATLAS_UI7_SHOTS) await page.screenshot({animations:"disabled",path:process.env.ATLAS_UI7_SHOTS+"/mobile-ru-routing.png"});
  }
});

test("unavailable isolation is reported on the requested desktop card", async ({page}, info) => {
  test.skip(info.project.name !== "desktop");
  const {verify} = await openFixture(page, info, {tab:"home", selectedFirst:true});
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd:string,args:unknown) => {
      if (cmd === "probe_desktop_profile") throw "unsupported_probe";
      return original(cmd,args);
    };
  });
  const row = page.locator(".atlas-server-entry").filter({hasText:"Second"}).first();
  await row.getByTestId("profile-probe-button").click();
  await expect(row.getByRole("status")).toContainText("reliable check is not yet available");
  await expect(page.locator(".atlas-server-trigger")).toContainText("First");
  await verify();
});
