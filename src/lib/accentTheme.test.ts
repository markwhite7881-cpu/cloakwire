import { describe, expect, it } from "vitest";
import { ACCENTS, loadSavedAccent, loadSavedOled } from "./accentTheme";

describe("accentTheme", () => {
  it("defines distinctive accents with required color tokens", () => {
    expect(new Set(ACCENTS.map(a => a.colorHex)).size).toBe(ACCENTS.length);
    const ids = ACCENTS.map((a) => a.id);
    expect(ids).toEqual(["emerald", "cyan", "violet", "amber", "rose", "azure", "indigo", "coral", "lime", "fuchsia", "slate"]);

    for (const accent of ACCENTS) {
      expect(accent.colorHex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(accent.hslValue).toBeTruthy();
      expect(accent.glowRgb).toBeTruthy();
      expect(accent.fromRgb).toBeTruthy();
      expect(accent.toRgb).toBeTruthy();
      expect(accent.badgeText).toBeTruthy();
      expect(accent.lightInk).toMatch(/^#[0-9a-f]{6}$/i);
      expect(accent.gradientClass).toBeTruthy();
    }
  });

  it("defaults to emerald when no saved accent is present", () => {
    expect(loadSavedAccent()).toBe("emerald");
  });

  it("defaults to false for OLED pitch-black mode", () => {
    expect(loadSavedOled()).toBe(false);
  });
});
