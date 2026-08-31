const DESKTOP_STORAGE_KEY = "cloakwire:desktop_expanded_subscriptions";
const MOBILE_STORAGE_KEY = "cloakwire:mobile_expanded_blocks";

export function loadExpandedSubscriptions(isMobile = false): Set<string> {
  try {
    const raw = window.localStorage.getItem(isMobile ? MOBILE_STORAGE_KEY : DESKTOP_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    // ignore
  }
  return new Set();
}

export function saveExpandedSubscriptions(expanded: Set<string>, isMobile = false): void {
  try {
    window.localStorage.setItem(
      isMobile ? MOBILE_STORAGE_KEY : DESKTOP_STORAGE_KEY,
      JSON.stringify(Array.from(expanded)),
    );
  } catch {
    // ignore
  }
}
