# Desktop isolated-probe implementation stage — 2026-10-31

Base: `57a778f`, branch `feat/connection-reliability-ux`. This is a D2 implementation checkpoint, **not completion of D2 or a release acceptance report**.

## Implemented

- Internal selected-profile adapter: native-owned resolved config, exact selected core, private authenticated loopback inbound, copied configuration, ephemeral reserved port, core preflight, socket readiness and at most three bind-collision attempts.
- One owner retains the actual child handle and private configuration through cancellation. Cleanup proves termination before removing its own files and before another probe can start. Cleanup failure makes the coordinator unavailable. No global process-name cleanup, TUN, firewall, system proxy or route writes.
- Fixed HTTPS targets with normal certificate validation, no redirects, explicit authenticated proxy, no inherited OS/environment proxy, exact 204 primary status and bounded 4096-byte structured fallback. Bodies, addresses and raw errors do not enter health DTOs.
- Read-only physical IPv4 default-route discovery on Windows/macOS, rejection of ambiguous/unavailable uplinks, opaque network fingerprint and before/after comparison. This snapshot is **not** an OS network-generation event source.
- Isolated work rejects active-session leases and identities containing a live run ID. It cannot mark an existing VPN session healthy.
- Child environment removes proxy and core-specific configuration/dialer overrides, including both uppercase and dotted Xray variables.

No start-probe IPC, active-session runtime injection, automatic recovery or UI status activation was added. Ordinary VPN start/stop and Android code are unchanged.

## Xray isolation gate

Bundled Xray 26.3.27 ignores socket-option binding failures and continues connecting. Before the fix, the new native regression supplied a nonexistent interface and still obtained Healthy. Production isolated Xray requests now return `unsupported_probe` before creating a child. They never silently switch to sing-box.

The test-only Xray loopback opt-in exercises transport, preflight, authentication and cleanup; it explicitly **does not** establish physical interface isolation. Its opt-in requires loopback targets and a loopback interface and does not exist in production builds.

The pure Xray adapter additionally rejects secondary download dialers, custom socket overrides, address/port DNS strategies and endpoint hostnames, including hostnames accompanied by `dns.hosts`. Sing-box dynamic ECH without supplied ECH material is unavailable because it can introduce implicit system DNS.

Sources checked against bundled implementations:

- [Xray binding errors are logged rather than returned](https://github.com/XTLS/Xray-core/blob/v26.3.27/transport/internet/system_dialer.go#L118-L138).
- [Xray independent XHTTP download dialer](https://github.com/XTLS/Xray-core/blob/v26.3.27/transport/internet/splithttp/dialer.go#L376-L411).
- [Xray environment configuration merging](https://github.com/XTLS/Xray-core/blob/v26.3.27/main/run.go#L173-L186).
- [Bundled sing-box ECH resolver](https://github.com/Leadaxe/sing-box-lx/blob/42e693ce1cbb2f76d611f17fae137c40deaf85fc/common/tls/ech.go).
- [Bundled sing-box interface control](https://github.com/Leadaxe/sing-box-lx/blob/42e693ce1cbb2f76d611f17fae137c40deaf85fc/common/dialer/default.go). The underlying control deliberately exempts loopback/multicast; loopback success is not physical binding evidence.

## Verification

| Check | Result |
| --- | --- |
| Windows safe Rust suite | 263 PASS, 9 ignored, 29 excluded |
| macOS arm64 safe Rust suite | 261 PASS, 9 ignored, 28 excluded |
| Windows diagnostics including explicit native cases | 38 PASS |
| macOS explicit native cases | 6 PASS |
| Whitespace validation | PASS |

Safe suite: `cargo test --lib -- --skip process:: --skip killswitch::`, with `CLOAKWIRE_TEST_MANIFEST=1`.

Explicit diagnostics: `cargo test --lib diagnostics:: -- --include-ignored --test-threads=1`. The six native tests require the bundled cores. They use loopback fixtures, except read-only physical-network discovery, and never modify system networking.

Native cases cover:

1. Repeatable physical discovery without publishing addresses.
2. Correct and wrong synthetic VLESS credentials through both cores; source config preserved, separate fixture core survives, temporary files removed.
3. User cancellation and deadline through both cores; owned child/config cleanup.
4. One port collision followed by success, and three collisions followed by bounded failure, through both cores.
5. Xray binding uncertainty cannot become Healthy.
6. External Xray configuration-directory environment cannot inject another config into preflight.

Tests first reproduced all five review findings: missing lease guard, ignored Xray binding failure, unsafe Xray options, dynamic ECH DNS and environment injection. The fix pass passed all relevant checks. The independent reviewer inspected the code read-only; the implementation agent ran the checks.

Private logs live in the ignored stage ledger directory. All profiles/credentials in these fixtures are synthetic. No user's server credentials were copied into source or reports.

## Remaining gates and next work

- D2: accepted active-session probe and controller/private-inbound ownership; member changes and network-generation invalidation; Reality/DNS-specific evidence; physical-target VPN-off/on matrix with unchanged routes/active session.
- Xray: positive interface-binding proof with the exact bundled core, or a separately authorized core change. Log timing alone is not proof. Current production gate stays closed.
- IPv6-only or ambiguous physical networks remain unavailable; no fallback through an unproven VPN interface.
- D3: remove Android global Xray cleanup, introduce independent process/session ownership and prove concurrent libbox diagnostics on the attached phone.
- D4/D5: safe runtime issue classification and integration with the accepted VPN session, followed by status/error-card wiring.
- Keep the user's accepted Android forced-task-close shutdown behavior. Ordinary Activity lifecycle checks remain separate.
- No new APK installation, release, push or merge in this stage. Version remains 1.4.9.
