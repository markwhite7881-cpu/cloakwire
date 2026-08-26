import { describe, expect, it } from "vitest";
import { executableNameFromPath } from "./processSelection";

describe("executableNameFromPath", () => {
  it("extracts a Windows executable name", () => {
    expect(executableNameFromPath(String.raw`C:\Program Files\Example App\example.exe`)).toBe("example.exe");
  });

  it("accepts Unix-style paths for other desktop targets", () => {
    expect(executableNameFromPath("/usr/local/bin/example")).toBe("example");
  });

  it("rejects empty or directory-only values", () => {
    expect(executableNameFromPath("   ")).toBeNull();
    expect(executableNameFromPath("..")) .toBeNull();
  });
});
