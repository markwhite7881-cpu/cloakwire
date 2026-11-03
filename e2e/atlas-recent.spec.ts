import { expect, test } from "playwright/test";
import { openFixture } from "./fixtures";

test("recent servers retain three distinct choices across tabs and reload", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const { verify } = await openFixture(page, info, { selectedFirst: true, serverNames: ["First","Second","Third","Fourth"], tab: mobile ? "servers" : "home" });
  const history = page.getByRole("region", { name: "Recent servers" });
  const choices = page.locator(mobile ? "main" : ".atlas-home-section");
  const nav = mobile ? page.locator(".atlas-bottom-nav button") : page.getByRole("tab");
  async function expectOrder(names: string[]) {
    const rows = history.getByRole("button");
    await expect(rows).toHaveCount(names.length);
    for (const [index, name] of names.entries()) await expect(rows.nth(index)).toContainText(name);
  }
  for (const name of ["Second", "Third", "Fourth"]) {
    await choices.locator("button.atlas-pick-row").filter({ hasText: name }).click();
  }
  if (mobile) await nav.first().click();
  await expectOrder(["Fourth", "Third", "Second"]);
  await history.getByRole("button", { name: /\bSecond\b/ }).click();
  await expectOrder(["Second", "Fourth", "Third"]);
  await expect(history.getByRole("button", { pressed: true })).toContainText("Second");
  await page.reload();
  await expectOrder(["Second", "Fourth", "Third"]);
  const dir = process.env.ATLAS_RECENT_SHOTS;
  if (dir) await history.screenshot({ path: dir + "/" + info.project.name + "-history.png" });
  await verify();
});

test("hover leaves a selected desktop routing card visually unchanged", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const { verify } = await openFixture(page, info, { selectedFirst: true, tab: "routing", theme: "dark" });
  const modes = page.locator(".atlas-policy .atlas-mode-selector");
  const selected = modes.getByRole("button", { pressed: true });
  const paint = () => selected.evaluate(node => {
    const style = getComputedStyle(node);
    return [style.backgroundColor, style.color, style.borderColor, style.boxShadow];
  });
  for (const name of ["Only selected", "All applications"]) {
    const target = modes.getByRole("button", { name, exact: true });
    await target.click();
    await page.mouse.move(0,0);
    await expect(selected).toHaveText(name);
    const before = await paint();
    await selected.hover();
    expect(await paint()).toEqual(before);
  }
  await selected.focus();
  expect(await selected.evaluate(node => node.matches(":focus"))).toBe(true);
  await verify();
});

test("saved history resolves ready subscriptions and manual profiles after upgrade", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const { verify } = await openFixture(page, info, { selectedFirst: true, subscription: true, tab: "home" });
  const history = page.getByRole("region", { name: "Recent servers" });
  await expect(history.getByRole("button", { pressed: true })).toContainText("First");
  await page.evaluate(mobile => {
    const store = JSON.parse(localStorage.getItem("singbox-client.manual-profiles.v2")!);
    const second = store.records.find((record: {outbound: {tag: string}}) => record.outbound.tag === "Second");
    const keys = mobile ? [JSON.stringify(["bundle","sub-a","child-0"]), JSON.stringify(["manual",second.id])] :
      ["ready:sub-a:child-0", "manual:" + second.id];
    localStorage.setItem(mobile ? "cloakwire.mobile.atlasRecent" : "cloakwire.desktop.recentProfiles", JSON.stringify(keys));
  }, mobile);
  await page.reload();
  const rows = history.getByRole("button");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Ready server A");
  await expect(rows.nth(1)).toContainText("Second");
  await rows.first().click();
  await expect(history.getByRole("button", { pressed: true })).toContainText("Ready server A");
  await verify();
});
