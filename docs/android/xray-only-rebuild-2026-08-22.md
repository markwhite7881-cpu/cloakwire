# Xray-only Android rebuild — 2026-08-22

## What changed

The v1.3.1 Android backend was rebuilt from scratch around a single
xray engine (approved plan, milestones 0–5; commits `97d93c2..1b3de65`).

### Architecture (v2rayNG-style, loop-free by construction)

```
apps → TUN (CloakwireVpnService, single fd owner, per-app include/exclude,
              own package always excluded)
     → hev-socks5-tunnel (in-process, jniLibs)
     → xray sidecar (socks inbound 127.0.0.1:10808)
     → outbounds (provider bundle or converted share-links)
        chained via sockopt.dialerProxy → "protected"
     → ProtectedSocks5Proxy (in-app 127.0.0.1:10810, protect() per dial)
     → physical network
```

sing-box is gone from Android entirely (no libbox.aar, no in-process
core): the desktop is untouched. Subscriptions (link-list, Clash YAML,
xray bundles) all flow through one Rust pipeline (`xray_config.rs`).

### Key facts

- Rust is the config source of truth: `generate_xray_config`
  (share-links), `normalize_bundle` (provider configs get the protected
  dialer spliced in, everything else untouched), `test_config`
  (latency tester spec).
- Subscription fetch runs over Kotlin HttpURLConnection (BoringSSL) —
  the in-process reqwest/rustls ClientHello is RST by anivka.top's
  edge. Real HTTP status + metadata headers (userinfo/expiry) flow
  back into the shared Rust classifier.
- Latency: "Ping all" is a real end-to-end test (short-lived tester
  xray, one socks inbound per profile, generate_204 through each);
  the 10 s auto-probe stays TCP-ping.
- geodata is copied assets → `filesDir/xray-assets` on first engine
  start; `XRAY_LOCATION_ASSET` points there.

## Build

```powershell
.\scripts\gradle-full-gates.ps1       # dist -> .so -> kotlin -> APK
.\scripts\sign-and-validate-xray.ps1  # release-key sign + verify
```

Output: `.android-build\Cloakwire_1.3.1_arm64-v8a.apk`.

## Device verification checklist (run in order)

Connect the phone (USB debugging), then:

```bash
ADB=/c/Users/Public/cwdev/android-sdk/platform-tools/adb.exe
APK=.android-build/Cloakwire_1.3.1_arm64-v8a.apk
"$ADB" install -r "$APK"
"$ADB" logcat -c && "$ADB" logcat | grep -iE "Cloakwire|XrayEngine|ProtectedSocks5|Tun2Socks|LatencyTester"
```

1. **App launch** — no crash; Settings shows the static `xray` badge
   and the real core version (e.g. `26.7.28`).
2. **Subscription add** — add a link-list provider (e.g. sub.hat.onl)
   and a HWID bundle provider (e.g. anivka.top). Both must classify;
   bundle children must appear with names; userinfo/expiry shown.
3. **Tunnel, link-list** — pick a server, Connect. State → running.
   In Chrome on the device open `1.1.1.1` / any site — traffic flows.
4. **Tunnel, xray bundle** — pick an anivka child, Connect, same
   check.
5. **Latency** — Servers → "Ping all": real ms values appear (and
   with the VPN both up and down).
6. **Per-app** — Routing: include-mode with one app (e.g. Chrome):
   only that app goes through the tunnel; exclude-mode: everything
   except it.
7. **Stop/start ×5** — repeated connect/disconnect without stuck
   states; kill the app from recents while connected → the VPN
   notification disappears (service teardown).
8. **Sidecar death** — `adb shell pkill -f libxray.so` mid-session:
   bounded restart (≤2) then a readable error, never a silent
   black-hole.
9. **Logs** — Logs screen: no URLs, UUIDs or credentials anywhere.

Known deferred items (v1.3.2): gRPC traffic stats (Observatory),
Hysteria2/TUIC profiles (not supported by xray-core).
