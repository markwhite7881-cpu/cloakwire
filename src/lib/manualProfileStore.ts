import type { Outbound } from "./types";

export const MANUAL_V1_KEY = "singbox-client.manual-profiles.v1";
export const MANUAL_V2_KEY = "singbox-client.manual-profiles.v2";
const RECOVERY_KEY = "singbox-client.manual-profiles.recovery";
export type ProfileStorage = Pick<Storage, "getItem" | "setItem">;
export interface ManualProfileRecord { id: string; revision: number; outbound: Outbound }
export interface ManualProfileEnvelope {
  version: 2; records: ManualProfileRecord[];
  legacyMirrorFingerprint: string | null; legacyMirrorStatus: "ready" | "pending";
}
export interface LoadResult {
  status: "ready" | "legacy_conflict" | "corrupt" | "write_failed" | "mirror_failed";
  records: ManualProfileRecord[]; legacy: Outbound[] | null;
}
export interface SaveResult { status: "saved" | "mirror_failed" | "failed" }
const protocols = new Set(["vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "unsupported"]);
function validOutbound(value: unknown): value is Outbound {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (o.protocol === "unsupported") return typeof o.raw === "string" && typeof o.reason === "string";
  return typeof o.protocol === "string" && protocols.has(o.protocol) && typeof o.tag === "string" && o.tag.length > 0;
}
function parseLegacy(raw: string | null): Outbound[] | null {
  if (raw === null) return [];
  try { const parsed: unknown = JSON.parse(raw); return Array.isArray(parsed) && parsed.every(validOutbound) ? parsed : null; }
  catch { return null; }
}
/** Deterministic comparison only; never displayed or sent to the backend. */
export function canonicalProfile(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(item => canonicalProfile(item ?? null)).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ":" + canonicalProfile(v)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
/** Change checksum, not a security/authentication hash. It stays in local storage. */
function fingerprint(raw: string | null): string | null {
  if (raw === null) return null;
  let normalized = raw;
  try { normalized = canonicalProfile(JSON.parse(raw)); } catch { /* malformed legacy still conflicts */ }
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(normalized)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}
export function newManualRecord(outbound: Outbound): ManualProfileRecord {
  return { id: crypto.randomUUID(), revision: 1, outbound: structuredClone(outbound) };
}
function validRecords(records: unknown): records is ManualProfileRecord[] {
  if (!Array.isArray(records)) return false;
  const ids = new Set<string>();
  return records.every(r => {
    if (!r || typeof r.id !== "string" || !r.id || ids.has(r.id) ||
      !Number.isSafeInteger(r.revision) || r.revision < 1 || !validOutbound(r.outbound)) return false;
    ids.add(r.id); return true;
  });
}
function parseEnvelope(raw: string): ManualProfileEnvelope | null {
  try {
    const value = JSON.parse(raw) as ManualProfileEnvelope;
    return value?.version === 2 && validRecords(value.records) &&
      ["ready", "pending"].includes(value.legacyMirrorStatus) &&
      (value.legacyMirrorFingerprint === null || typeof value.legacyMirrorFingerprint === "string") ? value : null;
  } catch { return null; }
}
export function toGeneratorOutbounds(records: ManualProfileRecord[]): Outbound[] {
  return records.map(record => record.outbound);
}
export function saveManualProfileStore(storage: ProfileStorage, records: ManualProfileRecord[]): SaveResult {
  if (!validRecords(records)) return { status: "failed" };
  let mirror: string, pending: ManualProfileEnvelope;
  try {
    mirror = JSON.stringify(toGeneratorOutbounds(records));
    pending = { version: 2, records, legacyMirrorFingerprint: fingerprint(storage.getItem(MANUAL_V1_KEY)), legacyMirrorStatus: "pending" };
    // Atomic envelope first: a failed primary write leaves legacy untouched.
    storage.setItem(MANUAL_V2_KEY, JSON.stringify(pending));
  } catch { return { status: "failed" }; }
  try {
    storage.setItem(MANUAL_V1_KEY, mirror);
    storage.setItem(MANUAL_V2_KEY, JSON.stringify({ ...pending, legacyMirrorFingerprint: fingerprint(mirror), legacyMirrorStatus: "ready" }));
    return { status: "saved" };
  } catch { return { status: "mirror_failed" }; }
}
export function loadManualProfileStore(storage: ProfileStorage): LoadResult {
  let v1: string | null, v2: string | null;
  try { v1 = storage.getItem(MANUAL_V1_KEY); v2 = storage.getItem(MANUAL_V2_KEY); }
  catch { return { status: "corrupt", records: [], legacy: null }; }
  const legacy = parseLegacy(v1);
  if (v2 === null) {
    if (!legacy) return { status: "corrupt", records: [], legacy: null };
    const records = legacy.map(newManualRecord);
    const saved = saveManualProfileStore(storage, records);
    return { status: saved.status === "saved" ? "ready" : saved.status === "failed" ? "write_failed" : "mirror_failed", records, legacy };
  }
  const envelope = parseEnvelope(v2);
  if (!envelope) return { status: "corrupt", records: [], legacy };
  const records = envelope.records;
  const matchesBase = fingerprint(v1) === envelope.legacyMirrorFingerprint;
  const matchesCurrent = !!legacy && canonicalProfile(legacy) === canonicalProfile(toGeneratorOutbounds(records));
  if (!matchesBase && !matchesCurrent || !legacy) return { status: "legacy_conflict", records, legacy };
  if (envelope.legacyMirrorStatus === "pending") {
    const saved = saveManualProfileStore(storage, records);
    return { status: saved.status === "saved" ? "ready" : "mirror_failed", records, legacy };
  }
  return { status: "ready", records, legacy };
}
export function replaceManualRecord(record: ManualProfileRecord, outbound: Outbound): ManualProfileRecord {
  const payload = (o: Outbound) => { const { tag: _tag, ...rest } = o as Outbound & { tag?: string }; return canonicalProfile(rest); };
  return { id: record.id, revision: record.revision + (payload(record.outbound) === payload(outbound) ? 0 : 1), outbound: structuredClone(outbound) };
}
export function resolveManualSelection(records: ManualProfileRecord[], pick: { id: string } | { legacyTag: string }):
  { kind: "selected"; id: string } | { kind: "missing" | "ambiguous" } {
  const matches = records.filter(r => "id" in pick ? r.id === pick.id : "tag" in r.outbound && r.outbound.tag === pick.legacyTag);
  return matches.length === 1 ? { kind: "selected", id: matches[0].id } : { kind: matches.length ? "ambiguous" : "missing" };
}
export function reconcileManualProfiles(records: ManualProfileRecord[], legacy: Outbound[], choice: "current" | "legacy" | "merge"): ManualProfileRecord[] {
  if (choice === "current") return records;
  const used = new Set<string>();
  const imported = legacy.map(outbound => {
    const matches = records.filter(r => canonicalProfile(r.outbound) === canonicalProfile(outbound));
    if (matches.length === 1 && !used.has(matches[0].id)) { used.add(matches[0].id); return matches[0]; }
    return newManualRecord(outbound);
  });
  return choice === "legacy" ? imported : [...records, ...imported.filter(r => !records.some(existing => existing.id === r.id))];
}
export function resolveManualStoreConflict(storage: ProfileStorage, loaded: LoadResult, choice: "current" | "legacy" | "merge"): SaveResult {
  if (choice !== "current" && !loaded.legacy) return { status: "failed" };
  // Keep the original bytes before an explicit user reconciliation.
  try { storage.setItem(RECOVERY_KEY, JSON.stringify({ v1: storage.getItem(MANUAL_V1_KEY), v2: storage.getItem(MANUAL_V2_KEY) })); }
  catch { return { status: "failed" }; }
  return saveManualProfileStore(storage, reconcileManualProfiles(loaded.records, loaded.legacy ?? [], choice));
}

/** Re-read before a UI write so a stale dialog cannot overwrite a newer collection. */
export function saveManualProfileStoreIfCurrent(storage:ProfileStorage,records:ManualProfileRecord[],expected:ManualProfileRecord[]):SaveResult|{status:"stale";latest:LoadResult}{
  const latest=loadManualProfileStore(storage);
  if(latest.status==="legacy_conflict"||latest.status==="corrupt"||canonicalProfile(latest.records)!==canonicalProfile(expected)){
    return {status:"stale",latest};
  }
  return saveManualProfileStore(storage,records);
}
