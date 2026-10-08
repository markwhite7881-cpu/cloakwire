import { describe, expect, it } from "vitest";
import { ACCENTS, loadSavedAccent, loadSavedOled } from "./accentTheme";

describe("accentTheme", () => {
  it("defines 5 distinctive vibrant accents with required color tokens", () => {
    expect(ACCENTS.length).toBe(5);
    const ids = ACCENTS.map((a) => a.id);
    expect(ids).toEqual(["emerald", "cyan", "violet", "amber", "rose"]);

    for (const accent of ACCENTS) {
      expect(accent.colorHex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(accent.hslValue).toBeTruthy();
      expect(accent.glowRgb).toBeTruthy();
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
