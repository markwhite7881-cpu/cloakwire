# Android Home Subscription Groups Design

Date: 2026-08-19

## Goal

Bring the desktop-style subscription grouping to the Android Home screen without changing VPN selection, configuration generation, or native VPN lifecycle behavior.

## Scope

- Show manual profiles in a `Manual` section.
- Show one section per subscription using only the safe subscription name.
- Render subscription profiles from the existing parsed subscription results.
- Preserve the existing flat profile array and `selectedIndex` values.
- Keep empty subscription sections visible.
- Reuse the existing mobile `SectionCard`/`SectionHeader` visual language.
- Add pure helper tests for grouping and selection-index preservation.

## Out of scope

- Native subscription persistence or fetching changes.
- Provider URLs, raw subscription payloads, UUIDs, credentials, or configuration display.
- Changes to `VpnPlugin`, `CloakwireVpnService`, `useVpnConnection`, or generated Android bridge files.
- Xray support or engine switching.
- Changes to the selected-server summary and connect button behavior.

## Design

`MobileApp` continues to build one flat `profiles` array through `buildGroupedServerProfiles`. It also passes the resulting `groups` to `HomeScreen`. Each group contains entries with the original flat `profileIndex`; Home selection remains owned by the existing `onSelect` callback and never derives an index from a rendered group position.

`HomeScreen` renders a compact server catalog below the existing connection summary. Manual entries are rendered first, followed by subscriptions in the same order as the subscription summaries. Each section uses the safe group label and contains the existing profile label/flag presentation. Empty groups remain visible with a muted empty-state row so a configured subscription is distinguishable from a missing subscription.

The current selected profile remains highlighted using `selectedIndex`. Selecting a supported entry calls the existing `onSelect(profileIndex)` callback, so `MobileApp` remains the single owner of selection and reconnect-notice behavior. The existing server summary still opens `ServersScreen` through `onOpenServers`; Home grouping does not duplicate selection state.

## Data safety

Only `Outbound` fields already safe for mobile display are rendered. Group labels come from the sanitized subscription summary. The Home component receives no provider URL and no raw provider response.

## Verification

- Pure grouping tests cover manual-first order, subscription order, empty groups, safe fallback labels, endpoint/tag deduplication, unsupported entries, and preserved flat indices.
- Frontend test suite and production build must pass.
- Android Kotlin compilation, unit tests, and sing-box-only ARM64 packaging-only build must pass.
- Git diff must contain only intended frontend source/test/spec changes; no generated bridge files, APKs, AARs, credentials, or build artifacts.
