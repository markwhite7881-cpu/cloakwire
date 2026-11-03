import { expect, test, type Page } from "playwright/test";
import { openFixture } from "./fixtures";

async function setSession(page: Page, mobile: boolean, running: boolean) {
  await page.evaluate(({mobile, running}) => {
    const w = window as any;
    if (mobile) {
      w.mobileStatus = {...w.mobileStatus, state: running ? "running" : "stopped",
        run_id: running ? "hood-test" : null, since: Date.now()-2300, profile_name: "First"};
      w.statusListener.onmessage(w.mobileStatus);
    } else {
      w.statusOverride = {status: running ? "running" : "stopped", pid: running ? 123 : null,
        run_id: running ? "hood-test" : null, engine: "singbox", uptime_secs: running ? 2 : null,
        last_error: null, last_exit_code: null};
    }
  }, {mobile, running});
}

test("the hood follows the session and the timer appears to the right of a stationary button", async ({page}, info) => {
  const {mobile, verify} = await openFixture(page, info, {tab:"home", locale:"ru", theme:"dark", selectedFirst:true, mobileLifecycle:true});
  const hood = page.locator(".atlas-hood-stage");
  const power = page.locator(".atlas-power");
  await expect(hood).toHaveAttribute("data-hood","off");
  // The mobile tab has its own entrance animation. Measure the settled controls.
  await power.evaluate(async button => {
    await document.fonts.ready;
    for (let el: Element | null = button; el; el = el.parentElement) {
      await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
    }
  });
  const before = (await power.boundingBox())!;
  if (mobile) await page.waitForFunction(() => !!(window as any).statusListener);
  await setSession(page, mobile, true);
  await expect(hood).toHaveAttribute("data-hood","on");
  await expect(hood.locator(".atlas-hood-front > g")).toHaveAttribute("opacity","1");
  const after = (await power.boundingBox())!;
  const timer = (await page.locator(".atlas-session-time").boundingBox())!;
  expect(Math.abs(before.x-after.x)).toBeLessThan(1);
  expect(Math.abs(before.y-after.y)).toBeLessThan(1);
  expect(Math.abs(before.width-after.width)).toBeLessThan(1);
  expect(timer.x).toBeGreaterThanOrEqual(after.x+after.width);
  expect(timer.y).toBeGreaterThanOrEqual(after.y);
  expect(timer.y+timer.height).toBeLessThanOrEqual(after.y+after.height);
  await expect(page.locator(".atlas-connection-panel details")).toHaveCount(0);
  await setSession(page, mobile, false);
  await expect(hood).toHaveAttribute("data-hood","off");
  await expect(hood.locator(".atlas-hood-front")).toBeHidden();
  await expect(page.locator(".atlas-session-time")).toHaveCount(0);
  await verify();
});

test("the cowl reverses mid-flight and honours the motion preference", async ({page}, info) => {
  test.skip(info.project.name !== "mobile", "Mobile status events allow a deterministic reversal within one frame.");
  const {verify} = await openFixture(page, info, {tab:"home", selectedFirst:true, mobileLifecycle:true});
  const hood = page.locator(".atlas-hood-stage");
  await page.waitForFunction(() => !!(window as any).statusListener);
  await expect(hood).toHaveAttribute("data-hood","off");
  await page.clock.install();
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()+150)));
  await setSession(page, true, true);
  await page.clock.runFor(550);
  await expect(hood).toHaveAttribute("data-hood","dressing");
  const front = hood.locator(".atlas-hood-front > g");
  const halfway = Number(await front.getAttribute("opacity"));
  expect(halfway).toBeGreaterThan(0);
  expect(halfway).toBeLessThan(1);
  await setSession(page, true, false);
  await page.clock.runFor(32);
  await expect(hood).toHaveAttribute("data-hood","lifting");
  expect(Number(await front.getAttribute("opacity"))).toBeLessThanOrEqual(halfway);
  await page.clock.runFor(600);
  await expect(hood).toHaveAttribute("data-hood","off");
  await page.emulateMedia({reducedMotion:"reduce"});
  await setSession(page, true, true);
  await expect(hood).toHaveAttribute("data-hood","on");
  await setSession(page, true, false);
  await expect(hood).toHaveAttribute("data-hood","off");
  await verify();
});
