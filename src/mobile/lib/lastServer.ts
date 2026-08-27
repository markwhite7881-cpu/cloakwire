// Last-connected-server persistence for the mobile shell.
//
// The selection state (`selectedIndex` / `activeBundle`) lives in
// React and is lost when the app process dies. On a cold start the
// UI must point at the same server the user last *connected*
// through — especially with auto-connect on, where connecting to
// `profiles[0]` would silently exit through the wrong country.
//
// Share-link picks are stored by their built tag (the same string
// `buildGroupedServerProfiles` produces, including the `@host:port`
// suffix it adds on duplicates), so the record survives subscription
// refreshes that reorder outbounds. Bundle picks keep the child
// identity; `connectWithSelection` revalidates it against Rust
// before using it.

import type { MobileEngine } from "./settings";

export type LastServerPick =
  | { kind: "profile"; tag: string }
  | { kind: "auto" }
  | {
      kind: "bundle";
      subscriptionId: string;
      childKey: string;
      engine: MobileEngine;
      childName: string;
    };

const KEY = "singbox.mobile.lastServer";

export function loadLastServer(): LastServerPick | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastServerPick;
    if (parsed.kind === "auto") return parsed;
    if (parsed.kind === "profile" && typeof parsed.tag === "string") {
      return parsed;
    }
    if (
      parsed.kind === "bundle" &&
      typeof parsed.subscriptionId === "string" &&
      typeof parsed.childKey === "string" &&
      typeof parsed.childName === "string" &&
      (parsed.engine === "xray" || parsed.engine === "singbox")
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLastServer(pick: LastServerPick): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(pick));
  } catch {
    /* storage disabled — non-fatal */
  }
}
