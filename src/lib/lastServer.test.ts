import { describe, expect, it } from "vitest";
import { connectionProfileStorageKey, parseLastServerPick } from "./lastServer";
import type { ConnectionProfile } from "./connectionProfiles";

const ready: ConnectionProfile = {
  kind: "ready_config",
  subscriptionId: "sub-1",
  key: "child-1",
  name: "Primary",
  engine: "xray",
};

const link: ConnectionProfile = {
  kind: "subscription",
  reference: { subscription_id: "sub-2", link_key: "index-3" },
  label: "Provider node",
  protocol: "vless",
};

describe("last server persistence", () => {
  it("uses opaque stable keys for subscription-owned servers", () => {
    expect(connectionProfileStorageKey(ready)).toBe("ready:sub-1:child-1");
    expect(connectionProfileStorageKey(link)).toBe("subscription:sub-2:index-3");
  });

  it("rejects malformed persisted state", () => {
    expect(parseLastServerPick(null)).toBeNull();
    expect(parseLastServerPick("not-json")).toBeNull();
    expect(parseLastServerPick('{"kind":"profile","key":""}')).toBeNull();
    expect(parseLastServerPick('{"kind":"auto"}')).toEqual({ kind: "auto" });
  });
});
