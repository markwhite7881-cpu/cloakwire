import type { Outbound, Subscription } from "../../lib/types";

export interface SubscriptionResultLike {
  outbounds: Outbound[];
}

export interface ServerGroupEntry {
  /** Index into the flat profile list used by VPN/configuration code. */
  profileIndex: number;
  profile: Outbound;
}

export interface ServerGroup {
  id: string;
  label: string;
  kind: "manual" | "subscription";
  subscriptionId?: string;
  entries: ServerGroupEntry[];
}

export interface GroupedServerProfiles {
  profiles: Outbound[];
  groups: ServerGroup[];
}

function safeSubscriptionLabel(subscription: Subscription): string {
  const label = subscription.name.trim();
  return label || "Subscription";
}

/**
 * Builds the mobile server list once, then projects it into desktop-style UI
 * groups. The returned profile indices are deliberately the same indices used
 * by connection selection and VPN configuration.
 */
export function buildGroupedServerProfiles(
  manualProfiles: Outbound[],
  subscriptions: Subscription[],
  lastResult: Record<string, SubscriptionResultLike>,
): GroupedServerProfiles {
  const profiles: Outbound[] = [];
  const groups: ServerGroup[] = [];
  const seenEndpoint = new Set<string>();
  const seenTag = new Set<string>();

  const appendGroup = (
    group: Omit<ServerGroup, "entries">,
    source: Outbound[],
  ) => {
    const entries: ServerGroupEntry[] = [];
    for (const profile of source) {
      if (profile.protocol === "unsupported") {
        const profileIndex = profiles.push(profile) - 1;
        entries.push({ profileIndex, profile });
        continue;
      }

      const endpoint = `${profile.server}:${profile.port}`;
      if (seenEndpoint.has(endpoint)) continue;

      let displayed = profile;
      if (seenTag.has(profile.tag)) {
        displayed = { ...profile, tag: `${profile.tag} @${endpoint}` };
      } else {
        seenTag.add(profile.tag);
      }

      seenEndpoint.add(endpoint);
      const profileIndex = profiles.push(displayed) - 1;
      entries.push({ profileIndex, profile: displayed });
    }
    groups.push({ ...group, entries });
  };

  appendGroup({ id: "manual", label: "Manual", kind: "manual" }, manualProfiles);
  for (const subscription of subscriptions) {
    appendGroup(
      {
        id: `subscription:${subscription.id}`,
        label: safeSubscriptionLabel(subscription),
        kind: "subscription",
        subscriptionId: subscription.id,
      },
      lastResult[subscription.id]?.outbounds ?? [],
    );
  }

  return { profiles, groups };
}
