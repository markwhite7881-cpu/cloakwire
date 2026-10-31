import type { Outbound, Subscription } from "../../lib/types";

export interface SubscriptionResultLike {
  outbounds: Outbound[];
}

export interface ServerGroupEntry {
  /** Index into the flat profile list used by VPN/configuration code. */
  profileIndex: number;
  profile: Outbound;
  manualId?: string;
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
  manualIds?: readonly string[],
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
    for (const [sourceIndex, profile] of source.entries()) {
      const identity = group.kind === "manual" && manualIds?.[sourceIndex] ? { manualId: manualIds[sourceIndex] } : {};
      if (profile.protocol === "unsupported") {
        const profileIndex = profiles.push(profile) - 1;
        entries.push({ profileIndex, profile, ...identity });
        continue;
      }

      const endpoint = `${profile.server}:${profile.port}`;
      if (seenEndpoint.has(endpoint) && !identity.manualId) continue;

      let displayed = profile;
      if (seenTag.has(profile.tag)) {
        const base = `${profile.tag} @${endpoint}`;
        let tag = base, suffix = 2;
        while (seenTag.has(tag)) tag = `${base} (${suffix++})`;
        displayed = { ...profile, tag };
      }
      seenTag.add(displayed.tag);

      seenEndpoint.add(endpoint);
      const profileIndex = profiles.push(displayed) - 1;
      entries.push({ profileIndex, profile: displayed, ...identity });
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
