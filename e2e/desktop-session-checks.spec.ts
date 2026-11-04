import { expect, test } from "playwright/test";
import { openFixture } from "./fixtures";

test.beforeEach(async ({}, info) => test.skip(info.project.name !== "desktop"));

test("Auto retries its accepted session from the server list", async ({page}, info) => {
  await openFixture(page, info, {tab:"home", selectedFirst:true, health:"healthy"});
  await expect(page.getByTestId("connection-health")).toBeVisible();
  await page.evaluate(() => {
    const current = (window as any).fixtureHealth;
    current.session.profile_ref = {kind:"auto", snapshot_id:"accepted-auto"};
    current.session.display_name = "auto";
    current.health.profile_ref = current.session.profile_ref;
  });
  const row = page.locator(".atlas-home-section .atlas-server-entry").filter({hasText:"Automatic selection"});
  await row.getByRole("button", {name:"Check connection"}).click();
  const calls = await page.evaluate(() => (window as any).nativeRequests);
  expect(calls.filter((c:any) => c.cmd === "retry_active_probe").map((c:any) => c.args.expected))
    .toMatchObject([{profile_ref:{kind:"auto",snapshot_id:"accepted-auto"}, run_id:"7"}]);
  expect(calls.filter((c:any) => c.cmd === "probe_desktop_profile")).toHaveLength(0);
  await expect(page.locator(".atlas-server-trigger")).toContainText("First");
});

for (const source of ["removed", "revised"]) test("a " + source + " source leaves a retry on its session error", async ({page}, info) => {
  await openFixture(page, info, {tab:"home", selectedFirst:true, health:"reality"});
  const card = page.getByTestId("connection-health");
  await expect(card).toBeVisible();
  if (source === "revised") {
    await page.evaluate(() => {
      const current = (window as any).fixtureHealth;
      const id = JSON.parse(localStorage.getItem("singbox-client.manual-profiles.v2")!).records[0].id;
      current.session.profile_ref = {kind:"manual", id};
      current.session.source_revision = "previous";
      current.health.profile_ref = current.session.profile_ref;
      current.session.display_name = "Previous profile revision";
    });
    await expect(page.locator(".atlas-active-note")).toContainText("Previous profile revision");
  }
  await card.getByRole("button", {name:"Check connection"}).click();
  const row = page.locator(".atlas-server-entry").filter({hasText:"First"}).first();
  await row.getByRole("button", {name:"Check server"}).click();
  const requests = await page.evaluate(() => (window as any).nativeRequests);
  expect(requests.filter((c:any) => c.cmd === "retry_active_probe")).toHaveLength(1);
  expect(requests.filter((c:any) => c.cmd === "probe_desktop_profile")).toHaveLength(1);
});

for (const change of ["network", "settings"]) test("retains isolated evidence as history after changing " + change, async ({page}, info) => {
  await openFixture(page, info, {tab:"home", selectedFirst:true});
  const row = page.locator(".atlas-server-entry").filter({hasText:"First"}).first();
  await row.getByRole("button", {name:"Check server"}).click();
  await expect(row).toContainText("Server reachable");
  if (change === "network") await page.evaluate(() => { (window as any).physicalNetwork = "next-network"; });
  else await page.locator(".atlas-home-modes").getByRole("button", {name:"Both"}).click();
  await expect(row).toContainText("Last check: reachable");
  if (change === "settings") {
    await page.locator(".atlas-home-modes").getByRole("button", {name:"TUN"}).click();
    await expect(row).toContainText("Last check: reachable");
  }
  expect(await page.evaluate(() => (window as any).nativeCalls.filter((cmd:string) => cmd === "probe_desktop_profile"))).toHaveLength(1);
});

test("the selector country is scoped to a running sing-box instance", async ({page}, info) => {
  await openFixture(page, info, {tab:"home", selectedFirst:true, health:"healthy"});
  await page.evaluate(() => {
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd:string,args:unknown) => cmd === "list_proxies"
      ? w.selectorOffline ? Promise.reject("unavailable") : Promise.resolve({proxies:{proxy:{now:"🇩🇪 Berlin"}}})
      : invoke(cmd,args);
  });
  const country = page.locator(".atlas-hero h2");
  await expect(country).toHaveText("Germany");
  await page.evaluate(() => {
    const w = window as any;
    w.selectorOffline = true;
    w.statusOverride = {status:"running",run_id:"8",engine:"singbox"};
  });
  await expect(country).not.toHaveText("Germany");
  await page.evaluate(() => {
    const w = window as any;
    w.statusOverride = {status:"running",run_id:"9",engine:"xray",profile_name:"🇯🇵 Tokyo"};
    w.fixtureHealth.session = {...w.fixtureHealth.session, engine:"xray",run_id:"9",display_name:"🇯🇵 Tokyo"};
  });
  await expect(country).toHaveText("Japan");
});
