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

for (const error of ["engine_unavailable", "Kill Switch: engine_unavailable"]) {
 it("explains manual reconnect after interrupted recovery: "+error,()=>{
  const html=renderToStaticMarkup(<ConnectionErrorCard error={error}/>);
  expect(html).toContain("The VPN stopped. Connect manually to restore the connection.");
  expect(html).not.toContain("engine_unavailable");
  if(error.startsWith("Kill Switch:"))expect(html).toContain("Traffic remains blocked by Kill Switch.");
 });
}

for(const error of ["recovery_exhausted","Kill Switch: recovery_exhausted"]) {
 it("explains exhausted recovery without a raw token: "+error,()=>{
  const html=renderToStaticMarkup(<ConnectionErrorCard error={error}/>);
  expect(html).toContain("Could not restore the VPN. Connect manually to try again.");
  expect(html).not.toContain("recovery_exhausted");
 });
}
