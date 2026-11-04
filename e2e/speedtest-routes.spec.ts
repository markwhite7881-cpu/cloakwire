import { expect, test } from "playwright/test";
import { openFixture } from "./fixtures";

test("damaged history cannot hide home or the remaining measurements", async ({page}, info) => {
  await page.addInitScript(() => localStorage.setItem("cloakwire.speedtest.history", JSON.stringify([
    {}, null, {id:"old", timestamp:5000, serverName:"Saved server", vpnActive:true, ping:22,
      jitter:3, downloadSpeed:16, uploadSpeed:4, clientIp:"203.0.113.28", colo:"FRA"},
  ])));
  const {verify} = await openFixture(page, info, {tab:"home", selectedFirst:true});
  const card = page.locator(".atlas-traffic");
  await card.locator("summary").click();
  await expect(card).toContainText("Saved server");
  await expect(card).toContainText("203.0.113.28");
  await expect(card).toContainText("FRA");
  await expect(card).toContainText("3 ms");
  await verify();
});

test("Android VPN failure never starts a direct test and direct mode requires its own action", async ({page}, info) => {
  test.skip(info.project.name !== "mobile");
  const {verify} = await openFixture(page, info, {tab:"home", mobileLifecycle:true, running:true, selectedFirst:true});
  let webRequests = 0;
  await page.route("https://speed.cloudflare.com/**", async route => {
    webRequests++;
    await route.fulfill({status:200,body:Buffer.alloc(128)});
  });
  await page.evaluate(() => {
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd: string,args: any) => {
      if (cmd === "android_vpn_speed_test") {
        if (args.runId !== "run-a") throw new Error("wrong active session");
        return Promise.reject("speedtest_route_unavailable");
      }
      return invoke(cmd,args);
    };
  });
  const card = page.locator(".atlas-traffic");
  await card.getByRole("button",{name:"Speed Test",exact:true}).click();
  await expect(card.getByRole("alert")).toContainText("active VPN route");
  expect(webRequests).toBe(0);
  await page.evaluate(() => {
    const w = window as any;
    w.mobileStatus = {...w.mobileStatus,state:"stopped",run_id:null};
    w.statusListener.onmessage(w.mobileStatus);
  });
  const direct = card.getByRole("button",{name:"Test direct connection",exact:true});
  await expect(direct).toBeVisible();
  expect(webRequests).toBe(0);
  await direct.click();
  await expect(card.getByRole("status")).toContainText("Direct Route");
  expect(webRequests).toBe(8);
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem("cloakwire.speedtest.history")!));
  expect(history).toHaveLength(1);
  expect(history[0].vpnActive).toBe(false);
  await verify();
});
