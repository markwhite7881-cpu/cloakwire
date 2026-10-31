
import { describe, expect, it } from "vitest";
import { retainedSelectionIndex, selectProfileKey } from "./profileSelection";
describe("selection survives list changes", () => {
  it("follows the same manual ID when another profile is inserted", () => {
    const pick = selectProfileKey(1, ["manual:a", "manual:b"]);
    expect(retainedSelectionIndex(pick, ["manual:new", "manual:a", "manual:b"])).toBe(2);
    expect(retainedSelectionIndex(pick, ["manual:a"])).toBe(-1);
  });
  it("keeps Auto and positional subscription keys explicit", () => {
    expect(retainedSelectionIndex(selectProfileKey(-1, ["manual:a"]), ["manual:b"])).toBe(-1);
    expect(retainedSelectionIndex(selectProfileKey(0, ["subscription:s:index-0"]), ["manual:a", "subscription:s:index-0"])).toBe(1);
  });
});
