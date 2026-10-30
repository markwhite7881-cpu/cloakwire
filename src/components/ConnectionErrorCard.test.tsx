import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionErrorCard } from "./ConnectionErrorCard";

describe("ConnectionErrorCard", () => {
  it("keeps ordinary connection failures visible without calling them profile-check failures", () => {
    const html = renderToStaticMarkup(<ConnectionErrorCard error="io: Access denied" />);
    expect(html).toContain("io: Access denied");
    expect(html).not.toContain("Profile check failed");
    expect(html).not.toContain("Copy safe report");
  });

  it("offers dismiss and safe report actions without rendering provider diagnostics", () => {
    const html = renderToStaticMarkup(<ConnectionErrorCard error="profile_check_invalid: password=private-secret" />);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("Copy safe report");
    expect(html).toContain("invalid or incomplete");
    expect(html).not.toContain("password");
    expect(html).not.toContain("private-secret");
  });
});

it("does not show an error card for an explicitly cancelled check", () => {
  expect(renderToStaticMarkup(<ConnectionErrorCard error="profile_check_cancelled" />)).toBe("");
});
