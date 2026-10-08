import { describe, expect, it } from "vitest";
import { formatDuration } from "./useSessionTimer";

describe("useSessionTimer", () => {
  it("formats duration into zero-padded HH:MM:SS", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(59)).toBe("00:00:59");
    expect(formatDuration(60)).toBe("00:01:00");
    expect(formatDuration(3665)).toBe("01:01:05");
    expect(formatDuration(86399)).toBe("23:59:59");
  });
});
