import { expect, test } from "playwright/test";
import { openFixture } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`Connection controls share geometry and keyboard behavior in ${theme} mode`, async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    const { verify } = await openFixture(page, info, {
      tab: mobile ? "settings" : "config",
      locale: "ru",
      theme,
      selectedFirst: true,
    });
    const capture = async (name: string) => {
      if (process.env.ATLAS_CONTROL_SHOTS) {
        await page.screenshot({
          path: `${process.env.ATLAS_CONTROL_SHOTS}/${info.project.name}-${theme}-${name}.png`,
          animations: "disabled",
        });
      }
    };
    const panel = page.locator(mobile ? "#atlas-android-connection" : "main");
    const switches = panel.getByRole("switch");
    await expect(switches).toHaveCount(mobile ? 3 : 2);
    await expect(switches.first()).toBeVisible();
    const sizes = await switches.evaluateAll(nodes => nodes.map(input => {
      const track = input.nextElementSibling as HTMLElement;
      const dimensions = (el: Element) => {
        const box = el.getBoundingClientRect();
        return [box.width, box.height];
      };
      return { hit: dimensions(input), track: dimensions(track), thumb: dimensions(track.firstElementChild!) };
    }));
    for (const size of sizes) {
      expect(size).toEqual({ hit: [44, 44], track: [40, 24], thumb: [16, 16] });
    }
    await capture("connection");

    if (mobile) {
      const recovery = switches.first();
      await expect(recovery).not.toBeChecked();
      await recovery.focus();
      await page.keyboard.press("Space");
      await expect(recovery).toBeChecked();
      await expect(switches.last()).toBeDisabled();
      await capture("states");
      await page.keyboard.press("Space");
      await expect(recovery).not.toBeChecked();

      await page.locator(".atlas-bottom-nav button").nth(1).click();
      await page.locator(".atlas-heading-actions button").click();
      const sheet = page.getByRole("dialog");
      const field = sheet.getByRole("textbox");
      const submit = sheet.getByRole("button", { name: "Добавить", exact: true });
      await expect(field).toBeVisible();
      await expect(submit).toBeDisabled();
      expect(await submit.evaluate(button => getComputedStyle(button).boxShadow)).toBe("none");
      await capture("import");
      await field.fill("https://provider.example/atlas");
      await expect(submit).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    } else {
      await page.getByRole("tab").nth(3).click();
      const editor = page.locator(".atlas-disclosure");
      await editor.locator("summary").click();
      await expect(editor.getByRole("switch").first()).toBeVisible();
      await capture("editor");
    }
    await verify();
  });
}
