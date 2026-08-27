import assert from "node:assert/strict";
import { test } from "vitest";
import type { Outbound, Subscription } from "../../lib/types.ts";
import { buildHomeServerCatalog } from "./homeServerCatalog.ts";
import { buildGroupedServerProfiles } from "./serverGrouping.ts";

function profile(tag: string, server: string): Outbound {
  return {
    protocol: "vless",
    tag,
    server,
    port: 443,
    uuid: "test-uuid",
    transport: { kind: "tcp" },
    tls: { enabled: true, alpn: [], allow_insecure: false },
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

test("keeps empty subscription sections and marks only the matching flat index selected", () => {
  const { groups } = buildGroupedServerProfiles(
    [profile("Manual", "manual.example")],
    [subscription("work", "Work"), subscription("empty", "Empty")],
    { work: { outbounds: [profile("Work server", "work.example")] } },
  );

  const catalog = buildHomeServerCatalog(groups, 1);

  assert.deepEqual(
    catalog.map((group) => [group.label, group.entries.length]),
    [
      ["Manual", 1],
      ["Work", 1],
      ["Empty", 0],
    ],
  );
  assert.deepEqual(
    catalog.flatMap((group) =>
      group.entries.map((entry) => [entry.profileIndex, entry.selected]),
    ),
    [
      [0, false],
      [1, true],
    ],
  );
});
