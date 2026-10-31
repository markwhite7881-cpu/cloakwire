import { describe, expect, it } from "vitest";
import { connectionProfileStorageKey, parseLastServerPick, restoreDesktopSelection } from "./lastServer";
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

describe("stable manual selection", () => {
  const outbound = { protocol: "unsupported", raw: "synthetic", reason: "fixture", tag: "Same" } as const;
  it("uses the ID independently of names and refuses ambiguous legacy names", () => {
    const profiles: ConnectionProfile[] = [
      { kind: "manual", id: "one", revision: 1, outbound },
      { kind: "manual", id: "two", revision: 1, outbound },
    ];
    expect(connectionProfileStorageKey(profiles[1])).toBe("manual:two");
    expect(restoreDesktopSelection(profiles, { kind: "profile", key: "manual:Same" })).toEqual({ kind: "ambiguous" });
    expect(restoreDesktopSelection(profiles, { kind: "profile", key: "manual:two", version: 2 })).toEqual({ kind: "selected", index: 1 });
  });
});
