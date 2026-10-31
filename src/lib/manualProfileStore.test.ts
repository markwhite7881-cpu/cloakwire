import mergedFixture from "./fixtures/manual-merged-profiles.json";
import { describe, expect, it } from "vitest";
import { loadManualProfileStore, saveManualProfileStore, saveManualProfileStoreIfCurrent, resolveManualStoreConflict, reconcileManualProfiles, replaceManualRecord, resolveManualSelection, toGeneratorOutbounds, MANUAL_V1_KEY, MANUAL_V2_KEY, type ProfileStorage } from "./manualProfileStore";
import type { Outbound } from "./types";

const outbound = (tag = "Same", uuid = "11111111-1111-4111-8111-111111111111"): Outbound =>
  ({ protocol: "vless", tag, server: "example.invalid", port: 443, uuid, tls: { enabled: true, alpn: [], allow_insecure: false }, transport: { kind: "tcp" } });
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial)); let failKey: string | null = null;
  const storage: ProfileStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (key === failKey) throw new Error("quota"); values.set(key, value); } };
  return { storage, values, fail: (key: string | null) => { failKey = key; } };
}
describe("manual profile v2 persistence", () => {
  it("migrates idempotently, keeps v1, and sends only outbound payload to the generator", () => {
    const legacy = JSON.stringify([outbound()]);
    const { storage } = memory({ [MANUAL_V1_KEY]: legacy });
    const first = loadManualProfileStore(storage);
    expect(first.status).toBe("ready");
    expect(first.records[0].id).toBeTruthy();
    expect(loadManualProfileStore(storage).records).toEqual(first.records);
    expect(JSON.parse(storage.getItem(MANUAL_V1_KEY)!)).toEqual([outbound()]);
    expect(toGeneratorOutbounds(first.records)).toEqual([outbound()]);
    expect(toGeneratorOutbounds(first.records)[0]).not.toHaveProperty("revision");
  });
  it("does not lose original data or announce success when v2 write fails", () => {
    const legacy = JSON.stringify([outbound()]);
    const store = memory({ [MANUAL_V1_KEY]: legacy }); store.fail(MANUAL_V2_KEY);
    const result = loadManualProfileStore(store.storage);
    expect(result.status).toBe("write_failed");
    expect(store.storage.getItem(MANUAL_V1_KEY)).toBe(legacy);
    expect(store.storage.getItem(MANUAL_V2_KEY)).toBeNull();
  });
  it("keeps rename identity/revision and detects connection parameter changes", () => {
    const { storage } = memory({ [MANUAL_V1_KEY]: JSON.stringify([outbound()]) });
    const record = loadManualProfileStore(storage).records[0];
    const renamed = replaceManualRecord(record, { ...record.outbound, tag: "Renamed" } as Outbound);
    expect(renamed.id).toBe(record.id); expect(renamed.revision).toBe(record.revision);
    const changed = replaceManualRecord(renamed, outbound("Renamed", "new-user"));
    expect(changed.revision).toBe(record.revision + 1); expect(changed.id).toBe(record.id);
  });
  it("duplicate legacy names never guess a selected record", () => {
    const { storage } = memory({ [MANUAL_V1_KEY]: JSON.stringify([outbound(), outbound("Same", "another-user")]) });
    const { records } = loadManualProfileStore(storage);
    expect(resolveManualSelection(records, { legacyTag: "Same" })).toEqual({ kind: "ambiguous" });
    expect(resolveManualSelection(records, { id: records[1].id })).toEqual({ kind: "selected", id: records[1].id });
  });
  it("detects downgrade edits without replacing either collection", () => {
    const { storage } = memory({ [MANUAL_V1_KEY]: JSON.stringify([outbound()]) });
    const first = loadManualProfileStore(storage);
    const before = storage.getItem(MANUAL_V2_KEY);
    const legacy = JSON.stringify([outbound("Edited in old app", "other-user")]); storage.setItem(MANUAL_V1_KEY, legacy);
    const conflict = loadManualProfileStore(storage);
    expect(conflict.status).toBe("legacy_conflict"); expect(conflict.records).toEqual(first.records);
    expect(storage.getItem(MANUAL_V2_KEY)).toBe(before); expect(storage.getItem(MANUAL_V1_KEY)).toBe(legacy);
    expect(conflict.legacy).toEqual([outbound("Edited in old app", "other-user")]);
  });
  it("reports mirror failure and can finish a pending mirror without losing the newer v2", () => {
    const store = memory({ [MANUAL_V1_KEY]: JSON.stringify([outbound()]) });
    const first = loadManualProfileStore(store.storage);
    const updated = [replaceManualRecord(first.records[0], outbound("Updated", "changed"))];
    store.fail(MANUAL_V1_KEY);
    expect(saveManualProfileStore(store.storage, updated).status).toBe("mirror_failed");
    expect(JSON.parse(store.storage.getItem(MANUAL_V2_KEY)!).records).toEqual(updated);
    store.fail(null);
    expect(loadManualProfileStore(store.storage).records).toEqual(updated);
    expect(JSON.parse(store.storage.getItem(MANUAL_V1_KEY)!)).toEqual([updated[0].outbound]);
  });
  it("pending mirror plus old-app edits is still a conflict", () => {
    const store = memory({ [MANUAL_V1_KEY]: JSON.stringify([outbound()]) });
    const records = loadManualProfileStore(store.storage).records;
    store.fail(MANUAL_V1_KEY); saveManualProfileStore(store.storage, [replaceManualRecord(records[0], outbound("new"))]);
    store.fail(null); store.storage.setItem(MANUAL_V1_KEY, JSON.stringify([outbound("old-app edit")]));
    expect(loadManualProfileStore(store.storage).status).toBe("legacy_conflict");
  });
  it("preserves corrupt source instead of overwriting it with an empty array", () => {
    const { storage } = memory({ [MANUAL_V2_KEY]: "{broken", [MANUAL_V1_KEY]: JSON.stringify([outbound()]) });
    expect(loadManualProfileStore(storage).status).toBe("corrupt");
    expect(storage.getItem(MANUAL_V2_KEY)).toBe("{broken");
  });
  it("reconciliation preserves unique exact IDs and both differing profiles", () => {
    const { storage } = memory({ [MANUAL_V1_KEY]: JSON.stringify([outbound()]) });
    const records = loadManualProfileStore(storage).records;
    const merged = reconcileManualProfiles(records, [outbound(), outbound("Same", "new-user")], "merge");
    expect(merged).toHaveLength(2); expect(merged[0].id).toBe(records[0].id);
    expect(merged[1].id).not.toBe(records[0].id);
    expect(merged.map(r => r.outbound)).toContainEqual(outbound("Same (2)", "new-user"));
    expect(merged[0].outbound).toEqual(outbound());
  });
});

it("does not overwrite a profile revision changed after the UI loaded",()=>{
  const {storage}=memory({[MANUAL_V1_KEY]:JSON.stringify([outbound()])});
  const loaded=loadManualProfileStore(storage);
  const newer=[replaceManualRecord(loaded.records[0],outbound("Newer name","newer-user"))];
  expect(saveManualProfileStore(storage,newer).status).toBe("saved");
  const result=saveManualProfileStoreIfCurrent(storage,[replaceManualRecord(loaded.records[0],outbound("Old dialog","late-user"))],loaded.records);
  expect(result.status).toBe("stale");
  expect(loadManualProfileStore(storage).records).toEqual(newer);
});

it("stale reconciliation preserves both newer source versions and refreshes the choice",()=>{
 const {storage}=memory({[MANUAL_V1_KEY]:JSON.stringify([outbound()])});
 loadManualProfileStore(storage);
 storage.setItem(MANUAL_V1_KEY,JSON.stringify([outbound("Same","legacy-B")]));
 const conflict=loadManualProfileStore(storage),before=storage.getItem(MANUAL_V2_KEY);
 const newer=JSON.stringify([outbound("Same","legacy-C")]);storage.setItem(MANUAL_V1_KEY,newer);
 expect(resolveManualStoreConflict(storage,conflict,"merge").status).toBe("stale");
 expect(storage.getItem(MANUAL_V1_KEY)).toBe(newer);expect(storage.getItem(MANUAL_V2_KEY)).toBe(before);
});

it("produces the shared core-check fixture after merging changed credentials",()=>{
 const {storage}=memory({[MANUAL_V1_KEY]:JSON.stringify([outbound()])});
 const current=loadManualProfileStore(storage);
 const legacy=[outbound("Same","22222222-2222-4222-8222-222222222222")];
 expect(reconcileManualProfiles(current.records,legacy,"merge").map(r=>r.outbound)).toEqual(mergedFixture);
});
