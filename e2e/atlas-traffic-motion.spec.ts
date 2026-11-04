import { expect, test } from "playwright/test";
import { openFixture } from "./fixtures";

// Deliver through the same plugin channel as the Android counters and wait for the actual chart update.
async function measure(svg: Element, down: number) {
  const path = svg.querySelector<SVGPathElement>('[data-series="down"]')!;
  const group = path.parentElement!;
  const changed = new Promise<void>(resolve => {
    const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
    observer.observe(path, { attributes: true, attributeFilter: ["d"] });
  });
  const requests = (window as any).nativeRequests as { cmd: string; args: any }[];
  const channel = requests.filter(r => r.cmd === "plugin:vpn|register_listener" && r.args.event === "traffic").at(-1)!;
  channel.args.handler.onmessage({ down_bps: down * 125_000, up_bps: 125_000, down_total: 0, up_total: 0, ts_ms: Date.now() });
  await changed;
  const animation = group.getAnimations()[0];
  if (!animation) return null;
  const playing = animation.playState;
  animation.pause();
  const duration = Number(animation.effect!.getTiming().duration);
  const offset = (fraction: number) => {
    animation.currentTime = fraction * duration;
    return new DOMMatrixReadOnly(getComputedStyle(group).transform).e;
  };
  return { playing, earlier: offset(.25), later: offset(.75) };
}

test("measured traffic scrolls between samples and snaps immediately with reduced motion", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const { verify } = await openFixture(page, info, { tab: "home", running: true, selectedFirst: true });
  const card = page.locator(".atlas-traffic");
  const chart = card.getByRole("img", { name: "Traffic", exact: true });
  await expect(page.locator(".atlas-server-trigger")).toContainText("First");
  await expect(page.locator(".atlas-recent button").first()).toContainText("First");
  await expect(async () => { await chart.scrollIntoViewIfNeeded(); await expect(chart).toBeInViewport(); }).toPass({ timeout: 5000 });
  await expect(chart).toBeInViewport();
  await page.waitForFunction(() => (window as any).nativeRequests.some((r: any) =>
    r.cmd === "plugin:vpn|register_listener" && r.args.event === "traffic"));
  expect(await chart.evaluate(measure, 2)).toBeNull();
  const motion = await chart.evaluate(measure, 8);
  expect(motion?.playing).toBe("running");
  expect(motion!.earlier).toBeGreaterThan(motion!.later);
  expect(motion!.later).toBeGreaterThan(0);
  await expect(card).toContainText("8 Mbps");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => chart.evaluate(svg => svg.querySelector("g")!.getAnimations().length)).toBe(0);
  expect(await chart.evaluate(measure, 4)).toBeNull();
  await expect(card).toContainText("4 Mbps");
  await expect(chart.locator('[data-series="down"]')).toHaveAttribute("d", /C.*1000 37$/);
  const nav = info.project.name === "mobile" ? page.locator(".atlas-bottom-nav button") : page.getByRole("tab");
  await nav.nth(1).click();
  await expect(chart).toHaveCount(0);
  await page.evaluate(() => {
    const channel = (window as any).nativeRequests.filter((r: any) => r.cmd === "plugin:vpn|register_listener" && r.args.event === "traffic").at(-1);
    channel.args.handler.onmessage({ down_bps: 2_500_000, up_bps: 0, down_total: 0, up_total: 0, ts_ms: Date.now() });
  });
  await nav.nth(0).click();
  await expect(card).toContainText("20 Mbps");
  await expect(chart.locator('[data-series="down"]')).toHaveAttribute("d", /^M[^C]*(?: C[^C]+){3}$/);
  await verify();
});
