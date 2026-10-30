import type { ActiveChildConfig } from "@/lib/types";
import { profileCheckCode } from "@/lib/profileCheck";
import type { BundleChildOverride } from "../useVpnConnection";

export interface ReadyProfileSelection {
  subscriptionId: string;
  childKey: string;
  childName: string;
  engine: "singbox" | "xray";
}

/** A rejected ready profile must never silently connect a different server. */
export async function connectSelectedProfile(
  selection: ReadyProfileSelection | null,
  actions: {
    loadChild: (subscriptionId: string) => Promise<ActiveChildConfig>;
    connect: (override?: BundleChildOverride, name?: string) => Promise<void>;
    reportError: (error: unknown) => void;
  },
): Promise<void> {
  if (!selection) {
    await actions.connect();
    return;
  }
  try {
    const child = await actions.loadChild(selection.subscriptionId);
    if (child.child_key !== selection.childKey) {
      actions.reportError("profile_check_invalid");
      return;
    }
    await actions.connect({ engine: child.engine, config: child.config, name: selection.childName }, selection.childName);
  } catch (error) {
    actions.reportError(profileCheckCode(error) ?? "profile_check_failed");
  }
}
