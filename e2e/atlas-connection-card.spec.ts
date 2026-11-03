import { expect, test } from "playwright/test";
import { openFixture } from "./fixtures";

test("the connection card names the selected server once and keeps checks visible", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const { verify } = await openFixture(page, info, {
    tab: "home", selectedFirst: true, running: true, theme: "light", accent: "rose",
    ...(mobile ? { mobileLifecycle: true, profileProbe: true } : { health: "healthy" as const }),
  });
  const panel = page.locator(mobile ? ".atlas-connection-panel" : ".atlas-hero");
  await expect(panel.getByText("First", { exact: true })).toHaveCount(1);
  await expect(panel.locator(".atlas-session-time")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await expect(panel.locator(".atlas-connection-controls :is(h1,h2,[role=status])")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Recent servers" }).getByRole("button", { pressed: true })).toContainText("First");
  if (mobile) {
    await expect(panel.getByTestId("profile-probe-card").getByRole("button")).toBeVisible();
    await expect(panel.locator("details")).not.toHaveAttribute("open", "");
  } else {
    await expect(page.getByTestId("connection-health").getByRole("button").first()).toBeVisible();
  }
  const dir = process.env.ATLAS_UI5_SHOTS;
  if (dir) await panel.screenshot({ path: dir + "/" + info.project.name + "-card.png" });
  await verify();
});

test("Connect keeps readable text in enabled and disabled states", async ({ page }, info) => {
  const { verify } = await openFixture(page, info, { tab: "home", selectedFirst: true, theme: "dark", accent: "rose" });
  const connect = page.locator(".atlas-power");
  await expect(connect).toHaveText("Connect");
  const states = await connect.evaluate(node => [false, true].map(disabled => {
    const sample = node.cloneNode(true) as HTMLButtonElement;
    sample.disabled = disabled;
    node.parentElement!.appendChild(sample);
    const css = getComputedStyle(sample);
    function luminance(color: string) {
      const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
        const n = Number(value) / 255;
        return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
      });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    }
    const a = luminance(css.color), b = luminance(css.backgroundColor);
    const result = { contrast: (Math.max(a,b)+.05)/(Math.min(a,b)+.05), weight: Number(css.fontWeight), opacity: css.opacity };
    sample.remove();
    return result;
  }));
  for (const state of states) {
    expect(state.contrast).toBeGreaterThanOrEqual(4.5);
    expect(state.weight).toBeGreaterThanOrEqual(650);
    expect(state.opacity).toBe("1");
  }
  if (info.project.name === "desktop" && process.env.ATLAS_UI5_SHOTS) {
    await page.locator(".atlas-home-modes").screenshot({ path: process.env.ATLAS_UI5_SHOTS + "/desktop-modes.png" });
    await connect.screenshot({ path: process.env.ATLAS_UI5_SHOTS + "/desktop-connect.png" });
    await page.getByRole("tab").nth(3).click();
    await page.locator(".atlas-mode-selector").first().screenshot({ path: process.env.ATLAS_UI5_SHOTS + "/desktop-routing.png" });
  }
  await verify();
});

test("Android DNS menu saves both upstreams and restores them after reload", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  const { verify } = await openFixture(page, info, { tab: "settings", selectedFirst: true });
  const dns = page.locator("#atlas-android-network").getByRole("combobox").first();
  await dns.click();
  const list = page.getByRole("listbox");
  await expect(list.getByRole("option", { name: /Cloudflare/ })).toBeVisible();
  const dir = process.env.ATLAS_UI5_SHOTS;
  if (dir) await page.screenshot({ path: dir + "/mobile-dns.png" });
  await list.getByRole("option", { name: /Google/ }).click();
  await expect.poll(() => page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("singbox-client.settings.v2")!);
    return [s.local_dns, s.remote_dns];
  })).toEqual(["8.8.8.8", "https://dns.google/dns-query"]);
  await page.reload();
  await expect(dns).toContainText("Google");
  await verify();
});

test("desktop import keeps only rejected lines after partial success", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const { verify } = await openFixture(page, info, { tab: "home", selectedFirst: true });
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: unknown) => cmd === "parse_input" ?
      { outbounds: [], subscriptions: ["https://test.invalid/feed"], failures: [{ line: "invalid", error: { kind: "parse", message: "Invalid link" } }] } :
      invoke(cmd, args);
  });
  const dialog = page.getByRole("dialog");
  await page.locator("main").getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("textbox").fill("https://test.invalid/feed\ninvalid");
  await page.keyboard.press("Escape");
  await page.getByRole("tab").nth(1).click();
  await page.locator(".atlas-heading-actions button").click();
  await expect(dialog).toHaveJSProperty("open", true);
  const input = dialog.getByRole("textbox");
  await expect(input).toHaveValue("https://test.invalid/feed\ninvalid");
  const dir = process.env.ATLAS_UI5_SHOTS;
  if (dir) await page.screenshot({ path: dir + "/desktop-import.png" });
  await dialog.getByRole("button", { name: "Add Server", exact: true }).click();
  await expect(input).toHaveValue("invalid");
  await expect(dialog.getByRole("alert")).toContainText("Invalid link");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await verify();
});
