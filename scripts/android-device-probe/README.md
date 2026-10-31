# Explicit Android device checks

This is a **separate test-only APK**, not part of the Cloakwire application or release build. Its separate Android UID measures ordinary application traffic; Cloakwire's own excluded WebView cannot establish that evidence.

Run only on a device whose owner authorized VPN switching. Back up the installed APK and app data, verify update-signing compatibility, and never uninstall Cloakwire to bypass a signature mismatch. The runner requires an already running sing-box session, a retained manual selection, and the current mobile safety settings (kill switch off, IPv6 blocking off). The original app policy must capture the helper.

Build with the project's existing Gradle wrapper, JDK 17 and Android SDK 36:
```powershell
.\src-tauri\gen\android\gradlew.bat --project-dir scripts/android-device-probe assembleDebug
adb -s DEVICE install -t scripts/android-device-probe/build/outputs/apk/debug/CloakwireDeviceProbe-debug.apk
node scripts/android-device-check.mjs --adb PATH_TO_ADB --serial DEVICE --output REPORT.json --exercise-vpn --xray
```

The explicit `--exercise-vpn` flag is mandatory. `--xray` additionally converts the selected manual profile using the application's existing Xray generator and tests that engine; it does not validate every provider-ready JSON shape.

The runner checks stable manual selection, invalid-candidate rejection before replacing a live session, HTTPS through the VPN, and include/exclude app capture for each requested engine. It restores the accepted config and original app policy, compares the complete config privately, verifies settings/profiles/selection, and removes its allocated ADB debugger forwarding. It restores a disturbed session even if the invalid-candidate test itself fails. A report with `restored:false` requires immediate attention; do not proceed to another device case.

The actual accepted config owner mirrors `CloakwireVpnService.configFile()`: nonempty `files/xray-config.json` first, including for sing-box; only then legacy `configuration.json`. Contents never enter reports. The device must remain under the runner's control while checks execute; simultaneous manual changes are unsupported.

The helper only contacts fixed HTTPS test endpoints, checks TLS normally, refuses redirects, and never stores raw IPs or response bodies. The normal matrix requires HTTP 204 from gstatic and the expected Android VPN transport. Optional standalone `--ez compareEgress true` enables a bounded-body Cloudflare comparison, reporting only booleans. Failure to reach that optional endpoint is not proof of a failed VPN. The runner bounds helper execution and stops its own helper process in cleanup.

The matrix measures app capture plus real HTTPS traffic, **not** every domain/provider rule, DNS-leak behavior, UDP protocol, or matching the public exit IP to a particular profile. Known activity/task destruction is deliberately outside this routine matrix; its `NOT_RUN` entry must not be read as a pass. See the separate device report.

After use, remove only the test helper:
```powershell
adb -s DEVICE uninstall app.cloakwire.deviceprobe
```

Local regression checks:
```powershell
node --test scripts/android-device-check-helpers.test.mjs
```

Android API references: [Network.openConnection](https://developer.android.com/reference/android/net/Network#openConnection(java.net.URL)), [NetworkCapabilities](https://developer.android.com/reference/android/net/NetworkCapabilities).

The optional standalone Activity flag `--ez physicalControl true` compares fixed HTTPS/DNS requests on physical networks without libbox. It reports booleans only. This deliberately bypasses the default route where Android permits it; another UID's VPN/lockdown policy can prevent these requests. A failed control does not identify the root cause. It is a diagnostic aid, not part of the normal routing matrix.

The helper Activity requires Android DUMP permission (ADB shell/system). Optional `--ez xrayControl true --es testIPv4 <resolved-gstatic-IPv4>` separates default-VPN UDP and TLS transport from device DNS. TLS still checks www.gstatic.com normally; the supplied address is not written to reports.

Use `scripts/android-xray-isolation-check.mjs` for temporary-Xray ownership checks. Its loopback HTTP fixture is lifetime evidence, not an external health check. Both isolation runners require a working VPN and authorized device; they do not change its config.

The optional test flag --ez recoveryIdentity true records the opaque Android Network handle so recovery checks can verify that the VPN network was retained across a core replacement. It contains no address or profile data.
