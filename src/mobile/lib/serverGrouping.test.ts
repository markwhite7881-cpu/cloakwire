import assert from "node:assert/strict";
import { test } from "vitest";
import { buildGroupedServerProfiles } from "./serverGrouping.ts";
import type { Outbound, Subscription } from "../../lib/types.ts";

function profile(tag: string, server: string, port = 443): Outbound {
  return {
    protocol: "vless",
    tag,
    server,
    port,
    uuid: "test-uuid",
    transport: { kind: "tcp" },
    tls: {
      enabled: true,
      alpn: [],
      allow_insecure: false,
    },
  };
}

function subscription(id: string, name: string): Subscription {
  return {
    id,
    name,
    url: "",
    intervalMinutes: 60,
    lastFetchedAt: null,
    lastCount: 0,
    lastError: null,
    lastErrorKind: null,
    kind: "link_list",
    engine: null,
    activeChildKey: null,
    children: [],
  };
}

test("keeps manual first and groups subscription results in subscription order", () => {
  const result = buildGroupedServerProfiles(
    [profile("manual", "manual.example")],
    [subscription("sub-a", "Alpha"), subscription("sub-b", "Beta")],
    {
      "sub-a": { outbounds: [profile("alpha", "alpha.example")] },
      "sub-b": { outbounds: [profile("beta", "beta.example")] },
    },
  );

  assert.deepEqual(
    result.profiles.map((p) => (p.protocol === "unsupported" ? "unsupported" : p.tag)),
    ["manual", "alpha", "beta"],
  );
  assert.deepEqual(result.groups.map((g) => [g.id, g.label, g.entries.map((e) => e.profileIndex)]), [
    ["manual", "Manual", [0]],
    ["subscription:sub-a", "Alpha", [1]],
    ["subscription:sub-b", "Beta", [2]],
  ]);
});

test("maps Home group entries back to the flat selection profile list", () => {
  const result = buildGroupedServerProfiles(
    [profile("Manual server", "manual.example")],
    [subscription("sub-work", "Work")],
    { "sub-work": { outbounds: [profile("Subscription server", "work.example")] } },
  );

  assert.deepEqual(
    result.groups.flatMap((group) =>
      group.entries.map((entry) => {
        const profile = result.profiles[entry.profileIndex];
        return profile?.protocol === "unsupported" ? undefined : profile?.tag;
      }),
    ),
    ["Manual server", "Subscription server"],
  );
  assert.deepEqual(result.groups.map((group) => group.label), ["Manual", "Work"]);
});


test("deduplicates endpoints and disambiguates repeated tags while preserving flat indices", () => {
  const result = buildGroupedServerProfiles(
    [profile("Shared", "same.example"), profile("Shared", "manual-2.example")],
    [subscription("sub-a", "Provider")],
    { "sub-a": { outbounds: [profile("Shared", "manual-2.example"), profile("Shared", "sub.example")] } },
  );

  assert.equal(result.profiles.length, 3);
  assert.deepEqual(
    result.profiles.map((p) => (p.protocol === "unsupported" ? "unsupported" : p.tag)),
    ["Shared", "Shared @manual-2.example:443", "Shared @sub.example:443"],
  );
  assert.deepEqual(result.groups.map((g) => g.entries.map((e) => e.profileIndex)), [[0, 1], [2]]);
});

test("keeps empty subscription groups and uses a safe fallback label", () => {
  const result = buildGroupedServerProfiles([], [subscription("empty", "   ")], {});

  assert.deepEqual(result.profiles, []);
  assert.deepEqual(result.groups, [
    {
      id: "manual",
      label: "Manual",
      kind: "manual",
      entries: [],
    },
    {
      id: "subscription:empty",
      label: "Subscription",
      kind: "subscription",
      subscriptionId: "empty",
      entries: [],
    },
  ]);
});

test("keeps unsupported entries in their owning group without endpoint assumptions", () => {
  const unsupported: Outbound = {
    protocol: "unsupported",
    raw: "not-a-link",
    reason: "unsupported",
  };
  const result = buildGroupedServerProfiles([unsupported], [], {});

  assert.equal(result.profiles[0], unsupported);
  assert.deepEqual(result.groups[0]?.entries.map((e) => e.profileIndex), [0]);
});
