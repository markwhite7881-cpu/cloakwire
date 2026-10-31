import { useCallback, useMemo, useRef, useState } from "react";
import type { Outbound } from "@/lib/types";
import { canonicalProfile, loadManualProfileStore, newManualRecord,
  resolveManualStoreConflict, saveManualProfileStore, toGeneratorOutbounds,
  type LoadResult, type ManualProfileRecord, type ProfileStorage } from "@/lib/manualProfileStore";

function storage(): ProfileStorage {
  // Access can itself throw in a restricted WebView; all callers surface a safe state.
  return window.localStorage;
}
function initial(): LoadResult {
  if (typeof window === "undefined") return { status: "ready", records: [], legacy: [] };
  try { return loadManualProfileStore(storage()); }
  catch { return { status: "corrupt", records: [], legacy: null }; }
}
export function useManualProfiles() {
  const [state, setState] = useState<LoadResult>(initial);
  const current = useRef(state);
  const publish = useCallback((next: LoadResult) => { current.current = next; setState(next); }, []);
  const blocked = state.status === "legacy_conflict" || state.status === "corrupt" || state.status === "write_failed";
  const saveRecords = useCallback((records: ManualProfileRecord[]): boolean => {
    const prior = current.current;
    if (prior.status === "legacy_conflict" || prior.status === "corrupt" || prior.status === "write_failed") return false;
    let saved;
    try { saved = saveManualProfileStore(storage(), records); } catch { saved = { status: "failed" as const }; }
    if (saved.status === "failed") { publish({ ...prior, status: "write_failed" }); return false; }
    publish({ status: saved.status === "saved" ? "ready" : "mirror_failed", records, legacy: toGeneratorOutbounds(records) });
    return true;
  }, [publish]);
  const setOutbounds = useCallback((update: Outbound[] | ((outbounds: Outbound[]) => Outbound[])): boolean => {
    const prior = current.current.records;
    const next = typeof update === "function" ? update(toGeneratorOutbounds(prior)) : update;
    const used = new Set<string>();
    const records = next.map(outbound => {
      const original = prior.find(r => r.outbound === outbound && !used.has(r.id));
      const matches = prior.filter(r => !used.has(r.id) && canonicalProfile(r.outbound) === canonicalProfile(outbound));
      const record = original ?? (matches.length === 1 ? matches[0] : newManualRecord(outbound));
      used.add(record.id); return record;
    });
    return saveRecords(records);
  }, [saveRecords]);
  const reconcile = useCallback((choice: "current" | "legacy" | "merge"): boolean => {
    const prior = current.current;
    try {
      const result = resolveManualStoreConflict(storage(), prior, choice);
      if (result.status === "failed") return false;
      // Resolve generates IDs once in storage; reload the authoritative result.
      const loaded = loadManualProfileStore(storage());
      publish(loaded);
      return loaded.status === "ready" || loaded.status === "mirror_failed";
    } catch { return false; }
  }, [publish]);
  const retry = useCallback(() => {
    const prior = current.current;
    try {
      if (prior.status === "write_failed") {
        const result = saveManualProfileStore(storage(), prior.records);
        if (result.status !== "failed") publish(loadManualProfileStore(storage()));
      } else publish(loadManualProfileStore(storage()));
    } catch { /* existing visible error stays */ }
  }, [publish]);
  const outbounds = useMemo(() => toGeneratorOutbounds(state.records), [state.records]);
  return { state, records: state.records, outbounds, setOutbounds, saveRecords, blocked, reconcile, retry };
}
