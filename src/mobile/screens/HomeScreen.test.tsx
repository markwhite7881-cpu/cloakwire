import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import type { VpnConnection } from "../useVpnConnection";
import { HomeScreen } from "./HomeScreen";

function renderScreen(overrides: Partial<VpnConnection>, activeBundle: Parameters<typeof HomeScreen>[0]["activeBundle"] = null) {
  const vpn: VpnConnection = {
    state: "stopped", message: null, since: null, engine: "", ready: true, busy: false,
    error: null, reportError: () => {}, clearError: () => {},
    connect: async () => {}, disconnect: async () => {}, ...overrides,
  };
  return renderToStaticMarkup(
    <HomeScreen
      vpn={vpn}
      profiles={[]}
      groups={[]}
      selectedIndex={-1}
      geoipByIp={{}}
      settings={DEFAULT_SETTINGS}
      onSelect={() => {}}
      onOpenServers={() => {}}
      onOpenRouting={() => {}}
      activeBundle={activeBundle}
      onConnect={() => {}}
      subs={[]}
      onSelectBundleChild={() => {}}
    />,
  );
}

describe("HomeScreen profile validation feedback", () => {
  it.each(["stopped", "running"] as const)("shows an actionable failure while VPN state remains %s", (state) => {
    const html = renderScreen({ state, error: "profile_check_ruleset: secret-provider-url" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Profile check failed");
    expect(html).toContain("rule");
    expect(html).toContain("Refresh");
    expect(html).not.toContain("secret-provider-url");
  });

  it("shows the fresh preflight rejection after a previous service error", () => {
    const html = renderScreen({ state: "error", message: "VPN service exited", error: "profile_check_dns" });
    expect(html).toContain("Profile check failed");
    expect(html).toContain("DNS");
    expect(html).not.toContain("VPN service exited");
  });

  it("shows the service error when there is no newer failed action", () => {
    expect(renderScreen({ state: "error", message: "VPN service exited" })).toContain("VPN service exited");
  });

  it("keeps the connected label separate from the rejected selected target", () => {
    const html = renderScreen(
      { state: "running", profileName: "Current server", error: "profile_check_invalid" },
      { subscriptionId: "sub", childKey: "candidate", childName: "New candidate", engine: "singbox" },
    );
    const connectedLine = html.match(/<span>via<\/span>[\s\S]*?<\/button>/)?.[0];
    expect(connectedLine).toContain("Current server");
    expect(connectedLine).not.toContain("New candidate");
    expect(html).toContain("New candidate");
  });
});
