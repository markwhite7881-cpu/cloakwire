import type { ServerGroup, ServerGroupEntry } from "./serverGrouping";

export interface HomeServerCatalogEntry extends ServerGroupEntry {
  selected: boolean;
}

export interface HomeServerCatalogGroup extends Omit<ServerGroup, "entries"> {
  entries: HomeServerCatalogEntry[];
}

/**
 * Projects the shared grouped server model for Home without changing its order,
 * empty groups, or the flat profile indices used by connection selection.
 */
export function buildHomeServerCatalog(
  groups: ServerGroup[],
  selectedIndex: number,
): HomeServerCatalogGroup[] {
  return groups.map((group) => ({
    ...group,
    entries: group.entries.map((entry) => ({
      ...entry,
      selected: entry.profileIndex === selectedIndex,
    })),
  }));
}
