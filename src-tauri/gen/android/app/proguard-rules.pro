# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# `proguardFiles` setting in `build.gradle`.
#
# For more details, see:
#   http://developer.android.com/guide/developing/tools/proguard.html

# --- Tauri / wry JNI + reflection surface --------------------------------
# The entire Kotlin side of this app is Tauri glue (WryActivity,
# TauriActivity, RustWebView, Ipc, ...) plus our VpnPlugin. All of it
# is reached from native code (tao/wry/tauri call activity and
# plugin-manager methods BY NAME through JNI) or from JS
# (@JavascriptInterface) - references R8 cannot see. Two launch
# crashes on 2026-08-22 came from exactly this: tao 0.35.3 called
# MainActivity.getId() and tauri called getPluginManager() after R8
# had renamed them. The glue surface drifts with every tauri/wry
# release, so keep the whole app package; there is no other Kotlin
# code here to shrink.
-keep class ru.classquiz.singbox.** { *; }

# hev-socks5-tunnel binds its four TProxy* natives with
# RegisterNatives against the exact class name "hev/htproxy/TProxyService".
-keep class hev.htproxy.** { *; }

# All native methods keep their names.
-keepclasseswithmembernames class * {
    native <methods>;
}
