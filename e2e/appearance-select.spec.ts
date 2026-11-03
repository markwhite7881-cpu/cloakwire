import { expect, test } from "playwright/test";
import { openFixture } from "./fixtures";

test("Appearance menus support touch, keyboard, dismissal and persisted colors", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const { verify } = await openFixture(page, info, { tab: mobile ? "settings" : "config", selectedFirst: true, theme: "light", locale: "en" });
  const theme = page.getByRole("combobox", { name: "Theme Mode" });
  const accent = page.getByRole("combobox", { name: "Accent Color" });
  const menu = page.getByRole("listbox");
  await expect(page.locator(".atlas-index")).toHaveCount(0);
  await expect(theme).toContainText("Light");
  await theme.click();
  await expect(menu.getByRole("option", { selected: true })).toHaveText("Light");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveClass(/oled/);
  await expect(theme).toBeFocused();
  await accent.click();
  await expect(menu.getByRole("option")).toHaveCount(11);
  const viewport = page.viewportSize()!;
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(accent).toContainText("Emerald");
  await accent.click();
  await menu.getByRole("option", { name: "Coral", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "coral");
  await page.reload();
  await expect(accent).toContainText("Coral");
  await expect(theme).toContainText("OLED");
  await accent.click();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await theme.click();
  await menu.getByRole("option", { name: "Light", exact: true }).click();
  await accent.click();
  await accent.press("Home");
  const menuFonts = await page.evaluate(() => {
    const elements = [document.body, document.querySelector(".atlas-pref-row label")!,
      document.querySelector(".atlas-pref-trigger")!, document.querySelector('[role="option"]')!];
    return elements.map(el => getComputedStyle(el).fontFamily);
  });
  expect(new Set(menuFonts).size).toBe(1);
  const dir = process.env.ATLAS_APPEARANCE_SHOTS;
  if (dir) await page.screenshot({ path: dir + "/" + info.project.name + "-appearance.png" });
  await page.locator("h2").first().click();
  await expect(menu).toHaveCount(0);
  if (mobile) {
    await page.locator(".atlas-bottom-nav button").first().click();
    await page.locator(".atlas-session-details > summary").click();
    const mode = page.locator(".atlas-session-details > span");
    await expect(mode).toBeVisible();
    expect(await mode.evaluate(el => getComputedStyle(el).fontFamily)).toBe(menuFonts[0]);
  }
  await verify();
});
