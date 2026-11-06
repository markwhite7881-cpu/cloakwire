import {test, expect, type Page} from "playwright/test";
import {openFixture, settings} from "./fixtures";

async function choosePolicy(page: Page, mobile: boolean, mode: "all" | "include" | "exclude") {
  const name = mode === "all" ? (mobile ? "All apps" : "All applications")
    : mode === "include" ? "Only selected" : (mobile ? "All except selected" : "Except selected");
  await page.getByRole("button", {name, exact: true}).click();
  if (mode !== "all") {
    const picker = page.getByRole("button", {name: mobile ? "No apps selected" : "Pick from running processes…", exact: true});
    if (await picker.isVisible()) {
      await picker.click();
      await page.getByRole("button", {name: mobile ? /Fixture app/ : /fixture.exe/}).click();
    }
  }
  await page.getByRole("button", {name: "Apply routing", exact: true}).click();
}

// Hold only the native boundary. Routing UI, settings persistence and connect
// handlers are the real application. No installed VPN or network is touched.
async function holdStart(page: Page, mobile: boolean, command = mobile ? "generate_config" : "start_managed_singbox", engine?: "singbox" | "xray") {
  await page.evaluate(({mobile, command, engine}) => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    let held = false;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (!held && cmd === command) {
        held = true;
        w.routingStartCaptured = {cmd, args};
        await new Promise<void>(resolve => { w.releaseRoutingStart = resolve; });
      }
      if (cmd === "stop_singbox") {
        w.nativeCalls.push(cmd); w.nativeRequests.push({cmd, args});
        return w.statusOverride = {status: "stopped", run_id: null, engine: null, pid: null, uptime_secs: null, last_exit_code: null, last_error: null};
      }
      if (w.rejectNextRoutingStart && cmd === (mobile ? "plugin:vpn|start" : "start_managed_singbox")) {
        w.rejectNextRoutingStart = false;
        throw "profile_check_invalid";
      }
      const result = await original(cmd, args);
      if (cmd === "get_active_child_config" && engine) result.engine = engine;
      if (cmd === "start_managed_singbox" && engine) result.status.engine = engine;
      if (cmd === "start_managed_singbox") w.statusOverride = {...result.status, pid: 123, uptime_secs: 1, last_exit_code: null, last_error: null};
      return result;
    };
  }, {mobile, command, engine});
}

async function submittedRouting(page: Page, mobile: boolean) {
  return page.evaluate(mobile => {
    const req = (window as any).nativeRequests.filter((r: any) => r.cmd === (mobile ? "plugin:vpn|start" : "start_managed_singbox")).at(-1);
    return mobile ? {apps: JSON.parse(req.args.apps), mode: req.args.appsMode} : req.args.input.settings.routing;
  }, mobile);
}

for (const initialRunning of [true, false]) {
  for (const change of ["add-direct-policy", "remove-exclusion"] as const) {
    test(`${initialRunning ? "reconnect" : "first connect"} preserves routing edited during native preparation (${change})`, async ({page}, info) => {
      const {mobile} = await openFixture(page, info, {running: initialRunning, selectedFirst: true, tab: "routing", mobileLifecycle: true});
      await choosePolicy(page, mobile, change === "remove-exclusion" ? "exclude" : "all");
      await holdStart(page, mobile);
      if (initialRunning) await page.getByRole("button", {name: "Reconnect now", exact: true}).click();
      else {
        await page.getByText("Home", {exact: true}).first().click();
        await page.getByRole("button", {name: "Connect", exact: true}).click();
        await page.getByText("Routing", {exact: true}).first().click();
      }
      await page.waitForFunction(() => !!(window as any).releaseRoutingStart);
      const before = (await settings(page)).routing;
      await choosePolicy(page, mobile, change === "remove-exclusion" ? "all" : mobile ? "exclude" : "include");
      const latest = (await settings(page)).routing;
      await page.evaluate(() => (window as any).releaseRoutingStart());
      await expect.poll(() => page.evaluate(mobile => mobile ? (window as any).mobileStatus?.state : (window as any).statusOverride?.status, mobile)).toBe("running");
      // The accepted session really received the earlier settings. The UI must
      // retain an actionable notice until the newer policy is also accepted.
      const submitted = await submittedRouting(page, mobile);
      expect(submitted).toEqual(mobile ? {apps: before.tun_app_list, mode: before.tun_app_mode === "all" ? "exclude" : before.tun_app_mode} : before);
      await expect(page.getByRole("button", {name: "Reconnect now", exact: true})).toBeVisible();
      await page.getByRole("button", {name: "Reconnect now", exact: true}).click();
      await expect.poll(() => submittedRouting(page, mobile)).toEqual(mobile ? {apps: latest.tun_app_list, mode: latest.tun_app_mode === "all" ? "exclude" : latest.tun_app_mode} : latest);
      await expect(page.getByRole("button", {name: "Reconnect now", exact: true})).toHaveCount(0);
      await expect(page.getByText("Reconnecting…", {exact: true})).toHaveCount(0);
    });
  }
}

test("clean reconnect acknowledges routing without leaving a pending notice", async ({page}, info) => {
  const {mobile} = await openFixture(page, info, {running: true, selectedFirst: true, tab: "routing", mobileLifecycle: true});
  await choosePolicy(page, mobile, "exclude");
  await holdStart(page, mobile);
  await page.getByRole("button", {name: "Reconnect now", exact: true}).click();
  await page.waitForFunction(() => !!(window as any).releaseRoutingStart);
  await page.evaluate(() => (window as any).releaseRoutingStart());
  await expect.poll(() => page.evaluate(() => (window as any).nativeRequests.some((r: any) => r.cmd === "plugin:vpn|start" || r.cmd === "start_managed_singbox"))).toBe(true);
  await expect(page.getByText("Reconnecting…", {exact: true})).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Reconnect now", exact: true})).toHaveCount(0);
});

for (const engine of ["singbox", "xray"] as const) {
  test(`ready ${engine} profile retains routing edits until a successful retry applies them`, async ({page}, info) => {
    const {mobile} = await openFixture(page, info, {selectedFirst: true, tab: "home", mobileLifecycle: true, subscription: true});
    await page.getByRole("button", {name: /Provider A/}).first().click();
    await page.getByRole("button", {name: /Ready server A/}).first().click();
    await expect(page.locator(".atlas-server-trigger")).toContainText("Ready server A");
    await holdStart(page, mobile, mobile ? "get_active_child_config" : "start_managed_singbox", engine);
    await page.getByRole("button", {name: "Connect", exact: true}).click();
    await page.waitForFunction(() => !!(window as any).releaseRoutingStart);
    await page.getByText("Routing", {exact: true}).first().click();
    await choosePolicy(page, mobile, "exclude");
    const latest = (await settings(page)).routing;
    await page.evaluate(() => (window as any).releaseRoutingStart());
    const reconnect = page.getByRole("button", {name: "Reconnect now", exact: true});
    await expect(reconnect).toBeVisible();
    await page.evaluate(() => { (window as any).rejectNextRoutingStart = true; });
    await reconnect.click();
    await page.waitForFunction(() => (window as any).rejectNextRoutingStart === false);
    const retry = page.getByRole("button", {name: mobile ? "Retry" : "Reconnect now", exact: true});
    await expect(retry).toBeEnabled();
    expect(await page.evaluate(() => (window as any).nativeCalls.filter((cmd: string) => cmd === "stop_singbox" || cmd === "plugin:vpn|stop"))).toEqual([]);
    await retry.click();
    await expect.poll(() => submittedRouting(page, mobile)).toEqual(mobile ? {apps: ["fixture.app"], mode: "exclude"} : latest);
    await expect(retry).toHaveCount(0);
    await expect(reconnect).toHaveCount(0);
    const nativeEngine = await page.evaluate(mobile => mobile ? (window as any).mobileStatus?.engine : (window as any).statusOverride?.engine, mobile);
    expect(nativeEngine).toBe(engine === "singbox" && mobile ? "sing-box" : engine);
  });
}

test("desktop edits during Stop are not acknowledged with an older profile-selection snapshot", async ({page}, info) => {
  test.skip(info.project.name !== "desktop");
  await openFixture(page, info, {running: true, selectedFirst: true, tab: "home"});
  await holdStart(page, false, "stop_singbox");
  await page.locator(".atlas-server-trigger").click();
  await page.locator(".atlas-popover").getByRole("button", {name: /Second/}).click();
  await page.waitForFunction(() => !!(window as any).releaseRoutingStart);
  await page.getByText("Routing", {exact: true}).first().click();
  await choosePolicy(page, false, "include");
  await page.evaluate(() => (window as any).releaseRoutingStart());
  await expect(page.getByRole("button", {name: "Reconnect now", exact: true})).toBeVisible();
  expect((await submittedRouting(page, false)).vpn_processes).toEqual([]);
  await page.getByRole("button", {name: "Reconnect now", exact: true}).click();
  await expect.poll(() => submittedRouting(page, false)).toMatchObject({vpn_processes: ["fixture.exe"], final_outbound: "direct"});
  await expect(page.getByRole("button", {name: "Reconnect now", exact: true})).toHaveCount(0);
});
