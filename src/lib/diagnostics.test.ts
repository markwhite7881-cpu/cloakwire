import { describe, expect, it } from "vitest";
import { buildDiagnosticsReport, redactDiagnosticText } from "./diagnostics";

describe("diagnostics", () => {
  it("redacts credentials and identifiers", () => {
    const safe = redactDiagnosticText("vless://user@example.com:443?q=secret 550e8400-e29b-41d4-a716-446655440000 1.2.3.4");
    expect(safe).not.toContain("secret");
    expect(safe).not.toContain("550e8400");
    expect(safe).not.toContain("1.2.3.4");
  });

  it("bounds the included log tail", () => {
    const report = buildDiagnosticsReport({
      platform: "test",
      appVersion: "1.3.1",
      logLines: Array.from({ length: 250 }, (_, i) => `line-${i}`),
    });
    expect(report).not.toContain("line-49\n");
    expect(report).toContain("line-249");
  });
});
