# Android Home Subscription Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the existing grouped manual/subscription server model on Android Home while preserving flat profile indices and the existing selection/reconnect behavior.

**Architecture:** `MobileApp` remains the owner of the flat `profiles` array, `selectedIndex`, and `onSelectProfile`. `HomeScreen` receives the already-built `ServerGroup[]` from `buildGroupedServerProfiles` and renders each group using the safe display label and each entry’s preserved `profileIndex`. Home selection calls the existing `onSelectProfile` callback; no duplicate selection state or native changes are introduced.

**Tech Stack:** React + TypeScript, existing mobile `SectionCard`/`SectionHeader` components, existing Node `--experimental-strip-types --test` runner, Vite production build, Gradle Android ARM64 packaging-only validation.

## Global Constraints

- Work only in `C:\Users\Public\cwdev\cloakwire-android-v131-port`.
- Preserve the verified Android baseline and existing `VpnPlugin`/`CloakwireVpnService` lifecycle.
- Do not add or restore libXray dependencies; sing-box remains the only packaged engine.
- Do not expose provider URLs, UUIDs, credentials, raw configurations, or raw telemetry to the Home UI.
- Use only safe `Subscription.name` values for group labels; fall back to `Subscription` for blank names.
- Preserve the flat profile list and selection indices returned by `buildGroupedServerProfiles`.
- Do not commit generated bridge files, APK/AAR outputs, build directories, credentials, or raw subscription fixtures.

---

### Task 1: Lock the Home grouping contract with pure regression coverage

**Files:**
- Modify: `src/mobile/lib/serverGrouping.test.ts`
- Read-only reference: `src/mobile/lib/serverGrouping.ts`

**Interfaces:**
- Consumes: `buildGroupedServerProfiles(manualProfiles, subscriptions, lastResult)`.
- Produces: a regression assertion that a Home consumer can use `group.entries[].profileIndex` to select the same object from `result.profiles`.

- [ ] **Step 1: Add a focused regression test**

Add a test with one manual profile and one subscription result. Assert:

```ts
const result = buildGroupedServerProfiles(manual, subscriptions, lastResult);
assert.deepEqual(
  result.groups.flatMap((group) => group.entries.map((entry) => result.profiles[entry.profileIndex]?.tag)),
  ["Manual server", "Subscription server"],
);
assert.equal(result.groups[0]?.label, "Manual");
assert.equal(result.groups[1]?.label, "Work");
```

Use the existing test fixture style and protocol-safe `Outbound` objects; do not place credentials or provider URLs in the fixture.

- [ ] **Step 2: Run the focused test**

Run from the worktree:

```powershell
node --experimental-strip-types --test src/mobile/lib/serverGrouping.test.ts
```

Expected: all existing grouping tests plus the new Home selection-contract test pass.

- [ ] **Step 3: Review the helper boundary**

Confirm no helper change is needed: `ServerGroupEntry.profileIndex` already maps directly into `GroupedServerProfiles.profiles`, and `safeSubscriptionLabel` already prevents blank subscription names from reaching the UI.

- [ ] **Step 4: Commit the regression test**

```powershell
git add src/mobile/lib/serverGrouping.test.ts
git commit -m "test(android): cover Home grouping selection contract"
```

---

### Task 2: Render grouped servers on Home

**Files:**
- Modify: `src/mobile/screens/HomeScreen.tsx`
- Modify: `src/mobile/MobileApp.tsx`
- Test coverage: `src/mobile/lib/serverGrouping.test.ts`

**Interfaces:**
- `HomeScreen` adds:

```ts
groups: ServerGroup[];
onSelect: (index: number) => void;
```

- `MobileApp` passes the existing `serverGroups` and `onSelectProfile` values.
- Existing `onOpenServers` remains responsible for opening the Servers tab from the selected-server summary.

- [ ] **Step 1: Extend the HomeScreen props and imports**

Import `ServerGroup` from `../lib/serverGrouping`. Add `groups` and `onSelect` to the props destructuring and type. Do not change `vpn`, `profiles`, `selectedIndex`, or the summary calculations.

- [ ] **Step 2: Add the grouped catalog below the connection summary**

After the existing summary/traffic/session cards, render:

```tsx
<div className="flex flex-col gap-3">
  {groups.map((group) => (
    <SectionCard key={group.id}>
      <SectionHeader title={group.label} />
      {group.entries.length === 0 ? (
        <p className="px-3.5 py-3 text-xs text-muted-foreground">No servers loaded</p>
      ) : (
        <ul className="divide-y divide-border">
          {group.entries.map(({ profile, profileIndex }) => {
            const supported = isSupported(profile);
            const selected = profileIndex === selectedIndex;
            const { code } = flagForProfile({
              tag: supported ? profile.tag : undefined,
              server: supported ? profile.server : undefined,
              geoipByIp,
            });
            return (
              <li key={`home-srv-${profileIndex}`}>
                <button
                  type="button"
                  onClick={() => supported && onSelect(profileIndex)}
                  disabled={!supported}
                  className={cn(
                    "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors",
                    selected ? "bg-foreground/5" : "hover:bg-accent/60",
                    !supported && "opacity-50",
                  )}
                >
                  <span className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-emerald-400/70" : "border-muted-foreground/40",
                  )} aria-hidden>
                    {selected && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                  </span>
                  <FlagIcon code={code} size={18} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{profileLabel(profile)}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {supported ? profileEndpoint(profile) : "unsupported link"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  ))}
</div>
```

Use the existing `SectionCard`, `SectionHeader`, `FlagIcon`, `isSupported`, `profileEndpoint`, `profileLabel`, `cn`, and `flagForProfile` imports. Do not render URLs from subscription records; `profileEndpoint` only sees already-parsed `Outbound` values that the existing mobile Servers screen already displays.

- [ ] **Step 3: Wire the existing callbacks in MobileApp**

Update the Home invocation in `MobileApp.tsx`:

```tsx
<HomeScreen
  vpn={vpn}
  profiles={profiles}
  groups={serverGroups}
  selectedIndex={selectedIndex}
  geoipByIp={geoip.byIp}
  settings={settings}
  onSelect={onSelectProfile}
  onOpenServers={() => changeTab("servers")}
  onOpenRouting={() => changeTab("routing")}
/>
```

Do not modify `onSelectProfile`, `useVpnConnection`, or any Kotlin/native source.

- [ ] **Step 4: Run focused frontend checks**

```powershell
node --experimental-strip-types --test src/mobile/lib/serverGrouping.test.ts src/mobile/lib/reconnectState.test.ts src/lib/subscriptionStorage.test.ts
CLOAKWIRE_TEST_MANIFEST='' npm run build
```

Expected: all tests pass and Vite completes with only the existing large-chunk warning.

- [ ] **Step 5: Review the UI diff**

Confirm Home keeps the existing connection summary unchanged, renders `Manual` and subscription sections in group order, keeps empty sections visible, and calls `onSelect(profileIndex)` rather than using rendered row indices.

- [ ] **Step 6: Commit the Home implementation**

```powershell
git add src/mobile/screens/HomeScreen.tsx src/mobile/MobileApp.tsx
git commit -m "feat(android): group subscription servers on Home"
```

---

### Task 3: Run Android regression gates and clean the worktree

**Files:**
- No source changes expected.

- [ ] **Step 1: Run Kotlin compilation, unit tests, and packaging-only ARM64 build**

From `src-tauri/gen/android`:

```powershell
$env:GRADLE_USER_HOME = 'C:\Users\Public\cwdev\gradle-home'
.\gradlew.bat :app:compileArm64ReleaseKotlin :app:testArm64ReleaseUnitTest :app:assembleArm64Release --no-daemon --console=plain -x :app:rustBuildArm64Release
```

Expected: `BUILD SUCCESSFUL`; full normal Tauri Rust generation remains out of scope because it is blocked by the known WebSocket connection-refused environment failure.

- [ ] **Step 2: Restore generated TypeScript metadata if changed**

```powershell
git restore -- tsconfig.tsbuildinfo
```

- [ ] **Step 3: Verify source-only diff and artifact hygiene**

```powershell
git diff --check
git status --short
git diff HEAD~1 --name-only
```

Expected: no APK/AAR/build outputs, generated Android bridge files, credentials, or raw fixtures. The final source commits contain only the intended Home UI/test changes and the design/plan documentation.

- [ ] **Step 4: Record the final checkpoint**

Confirm the latest commit hash, test counts, production build result, Android gate result, and any unchanged known blockers in the final report.
