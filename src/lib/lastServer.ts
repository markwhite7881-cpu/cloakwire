import type { ConnectionProfile } from "./connectionProfiles";

export type LastServerPick =
  | { kind: "auto" }
  | { kind: "profile"; key: string };

const STORAGE_KEY = "cloakwire.desktop.lastServer.v1";

export function connectionProfileStorageKey(profile: ConnectionProfile): string | null {
  if (profile.kind === "manual") {
    return "tag" in profile.outbound && typeof profile.outbound.tag === "string"
      ? `manual:${profile.outbound.tag}`
      : null;
  }
  if (profile.kind === "subscription") {
    return `subscription:${profile.reference.subscription_id}:${profile.reference.link_key}`;
  }
  return `ready:${profile.subscriptionId}:${profile.key}`;
}

export function parseLastServerPick(raw: string | null): LastServerPick | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LastServerPick>;
    if (parsed.kind === "auto") return { kind: "auto" };
    if (parsed.kind === "profile" && typeof parsed.key === "string" && parsed.key.length > 0) {
      return { kind: "profile", key: parsed.key };
    }
  } catch {
    // Invalid state is ignored; the caller falls back to Auto.
  }
  return null;
}

export function loadLastServer(): LastServerPick | null {
  if (typeof window === "undefined") return null;
  try {
    return parseLastServerPick(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveLastServer(pick: LastServerPick): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pick));
  } catch {
    // Storage may be unavailable; connection behavior must remain unaffected.
  }
}
