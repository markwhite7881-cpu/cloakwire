import { useCallback, useEffect, useState } from "react";

const LIMIT = 3;

function loadHistory(storageKey: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(saved)) {
      return [...new Set(saved.filter((key): key is string => typeof key === "string" && key.length > 0))].slice(0, LIMIT);
    }
  } catch { /* Storage may be unavailable. */ }
  return [];
}

export function useRecentServers(storageKey: string, initialSelection?: string | null) {
  const [recent, setRecent] = useState(() => loadHistory(storageKey));
  const remember = useCallback((key: string | null | undefined) => {
    if (key) setRecent(previous => previous[0] === key ? previous : [key, ...previous.filter(item => item !== key)].slice(0, LIMIT));
  }, []);

  // Seed an empty history once. Restoring the last working VPN on startup
  // must not reorder choices the user made after their last successful connection.
  useEffect(() => {
    if (initialSelection) setRecent(previous => previous.length ? previous : [initialSelection]);
  }, [initialSelection]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(recent)); } catch { /* Keep the in-memory history. */ }
  }, [storageKey, recent]);

  return { recent, remember };
}
