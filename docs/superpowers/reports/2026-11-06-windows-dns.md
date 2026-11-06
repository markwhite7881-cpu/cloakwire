# Windows application routing and DNS regression — 2026-11-06

## Result and scope

Windows sing-box now chooses DNS using application routing, instead of sending every intercepted query to the VPN resolver. The change covers generated configurations and runtime copies of ready subscription configurations. No installed application, live VPN, system DNS, proxy, route or firewall setting was changed during verification. Android, macOS and Xray DNS behavior remains outside this Windows-only policy.

## Policy and privacy

- Generated DNS follows the effective route default: direct uses the local resolver; proxy/other tunnel outbounds use the remote resolver. Unknown owners and empty process lists follow that default.
- Explicit direct process selections run before VPN process selections, as in route.rules. A process in both lists uses direct. The remote resolver retains its proxy detour; a failed VPN query never retries through the local resolver.
- Representable process/domain/user/logical routing decisions keep their order. IP, port and protocol constraints describe the later connection rather than its DNS packet, so they are not converted by dropping matchers. An unprojectable VPN decision adds a conservative remote barrier. Direct decisions after that barrier are not widened.
- If direct process exclusions exist, the shared Windows DNS Client owners svchost.exe and System use local DNS after explicit local application/domain decisions and before the conservative barrier. This keeps excluded apps usable during a VPN DNS outage. The service multiplexes requests: **VPN apps using that same OS DNS service can also have their names resolved locally.** DNS routing by application can be enforced only when the engine can identify the actual app. Explicit VPN selection of the service itself still wins. Unidentified owners continue to follow the configured default.
- Ready profiles prepend local application/domain/shared-service policy before the complete provider DNS rule block. Provider rule contents and relative order are retained, including evaluate/respond chains. Known direct owners therefore receive real local answers even if the provider has a remote catchall or fake-IP default. With an effective direct default, a local catchall also takes precedence over provider transport defaults.
- A conservative remote barrier can intentionally bypass a ready provider's fake-IP/hosts/DNS feature pipeline for unmatched traffic. Explicit local process and approved shared-service decisions remain ahead of it. Custom VPN restrictions can intentionally retain VPN DNS dependence; this is not a promise to bypass every custom policy.
- With all applications through VPN and no effective local routing/DNS overrides, ready-profile DNS is preserved unchanged. Both historical Rust/DoH and current UI remote-DNS defaults are recognized. Active application policy adds collision-safe resolver tags; managed launches forward non-default local/remote DNS settings. A provider's default resolver is retained unless a direct default or non-default remote DNS setting requires replacement.
- Proxy endpoint hostnames bootstrap through the direct resolver when an active ready merge has no resolver or a null resolver. Explicit provider/user string and object resolver choices are retained, including when the provider also defines a local tag. Null optional DNS/servers/rules values accepted by the core are normalized only during an active merge; malformed strings are rejected.
- IPv4-only DNS behavior remains unchanged. No independent_cache flag is added: the exact bundled core already keys DNS cache entries by resolver transport tag.

The shared-service availability policy is deterministic configuration, not failure-triggered fallback. The native test aliases the exact shared-owner names to a real node.exe socket owner; it does not claim a live TUN or Windows DNS Client service integration test.

## Verification evidence

- Initial generator regressions failed for missing process/domain DNS rules and an incorrect remote DNS default under direct routing. Ready-profile, shared-service, provider catchall/fake-IP, bootstrap, current UI default and null compatibility regressions were observed RED before their fixes.
- Original loopback baseline: a fresh direct-app DNS query timed out with the proxy unavailable, while direct IP traffic worked. The checked-in native runner rejects this old configuration as expected.
- Safe full Rust library run: **353 passed, 0 failed, 16 ignored, 32 filtered out**. Excluded process:: and killswitch:: tests can alter OS networking; diagnostics::lifecycle_tests:: can invoke failed-start cleanup. Existing opt-in native tests stayed ignored.
- An initial ordinary cargo test invocation compiled successfully but its test executable stopped before entering tests with Windows STATUS_ENTRYPOINT_NOT_FOUND. The existing CLOAKWIRE_TEST_MANIFEST=1 option resolved the loader issue; subsequent safe runs passed. A later temporary test-import compilation error was corrected before the final green run.
- Final actual-crate bundled-core test: **18/18 generated/ready scenarios passed in 50.98 seconds**. Each checks configuration acceptance, fresh outage DNS, direct IP traffic, expected hostname traffic, healthy/cached/fresh queries across an outage, and no local fallback for explicit VPN DNS. The IPv4-only fixtures also assert zero-answer AAAA responses without upstream traffic.
- Additional native checks exercise the same hostname first cached locally and then queried through the unavailable VPN resolver; the local cache cannot satisfy it. Ready-profile checks retain a real fake-IP transport: the excluded node.exe receives local 127.0.0.1 answers, while a separate PowerShell UDP owner retains a provider 198.18/15 fake-IP answer. A ready proxy hostname boots with the retained/generated resolver policy rather than a harness-injected override.
- All networking uses 127.0.0.1. The test starts only owned loopback listeners and owned core/helper processes and closes them afterward. The bundled executable is src-tauri/binaries/sing-box-x86_64-pc-windows-msvc.exe.

## Reproduction commands

Run from the repository root with the existing Rust toolchain available. The native matrix also requires Node and the bundled Windows core.

~~~powershell
$env:CLOAKWIRE_TEST_MANIFEST='1'
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib -- --skip process:: --skip killswitch:: --skip diagnostics::lifecycle_tests::
$env:CLOAKWIRE_DNS_TEST_OUTPUT='<artifact-directory>'
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib config::tests::windows_dns_policy_passes_bundled_core -- --ignored --nocapture
~~~

The matrix emits original production input JSONs plus each rewritten loopback configuration, core log and results file. For individual replay:

~~~powershell
node scripts/test-windows-dns.cjs <CORE> <INPUT_JSON> direct|proxy <OUTPUT_DIRECTORY> [shared-owner] [bootstrap-hostname] [provider-fakeip] [cache-separation]
~~~

Useful matrix inputs and arguments:

| Input | Expected DNS | Optional argument |
| --- | --- | --- |
| include-unmatched-generated.json | direct | |
| include-vpn-generated.json | proxy | |
| exclude-direct-ready.json | direct | provider-fakeip |
| include-vpn-ready.json | proxy | bootstrap-hostname |
| shared-service-direct-ready.json | direct | shared-owner |
| shared-explicit-vpn-wins-ready.json | proxy | shared-owner |
| shared-domain-vpn-wins-ready.json | proxy | shared-owner |
| all-vpn-generated.json | proxy | cache-separation |

Session artifacts are under deep-routing/desktop/ in this chat's local visualization directory. Final inputs/results are in dns-native-final/; aggregate logs are dns-native-final.log and cargo-safe-dns-final.log. Baseline failure is dns-baseline-red/; bootstrap failure is dns-ready-bootstrap-red/. These machine-specific artifacts are not committed.

## Connection settings application

Desktop and Android connect attempts now capture a settings revision before asynchronous preparation. Only successful native acceptance acknowledges that revision. Later routing edits remain pending, including edits during desktop Stop, initial connection, ready-profile loading and reconnect. Mobile permission refusal, failed replacement and cancellation do not acknowledge edits or stop the accepted session.

Eight initial/reconnect race regressions failed before the fix; the ten basic scenarios passed after it. Expanded browser checks cover both ready-profile engines, failed native starts/retries and the desktop Stop window. The complete frontend run passed 207 unit tests and 132 browser scenarios with 50 platform skips. Five additional focused Android browser checks passed, including permission refusal and cancellation with pending changes. TypeScript and the production frontend build passed with existing SSR/bundle warnings.

The Android phone disconnected before implementation verification, so this is actual React behavior with controlled native boundaries, not an installed-device VPN test. The existing Windows VPN remained active. Independent UI/DNS reviews found no outstanding must-fix findings. Three native DNS cases were also independently replayed after the full matrix passed.

## Limits

The real installed VPN was not restarted. No live TUN, production subscription endpoint, actual Windows DNS Client ownership or external network throughput was tested. Raw-query ownership and the shared-owner alias are controlled loopback checks. The system DNS service cannot expose the original requester to ordinary process rules, so the shared-stream privacy tradeoff above remains a platform limitation.

Reference: [official DNS rules](https://sing-box.sagernet.org/configuration/dns/rule/) and [exact bundled-core cache implementation](https://github.com/Leadaxe/sing-box-lx/blob/42e693ce1cbb2f76d611f17fae137c40deaf85fc/dns/client.go).
