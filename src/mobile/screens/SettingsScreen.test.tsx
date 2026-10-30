import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { version } from "../../../package.json";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import { SettingsScreen } from "./SettingsScreen";

describe("SettingsScreen app version", () => {
  it("shows the installed application version separately from bundled engine versions", () => {
    const html = renderToStaticMarkup(
      <SettingsScreen
        settings={DEFAULT_SETTINGS}
        onSettingsChange={() => {}}
        autoConnect={false}
        onAutoConnectChange={() => {}}
        onRefreshAllSubs={() => {}}
        subsFetching={false}
        onOpenLogs={() => {}}
      />,
    );
    expect(html).toContain("Cloakwire");
    expect(html).toContain("v" + version);
    expect(html).toContain("Bundled sing-box and Xray cores");
  });
});
