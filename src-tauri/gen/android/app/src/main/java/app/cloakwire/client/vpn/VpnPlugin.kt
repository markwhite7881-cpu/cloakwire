package app.cloakwire.client.vpn

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

@InvokeArg
class StartArgs {
  /**
   * Full pre-built engine config JSON. Rust generates manual/share-link
   * sing-box configs and normalizes ready bundle configs. The plugin only
   * validates and persists the payload before handing it to the service.
   */
  var config: String = ""

  /** Engine for this config: "singbox" or "xray". */
  var engine: String = "singbox"

  /**
   * Per-app routing: JSON array of package names. Empty array means
   * "all apps" (the service still always excludes its own package).
   */
  var apps: String = "[]"

  /** `"include"` (only these apps) or `"exclude"` (all but these). */
  var appsMode: String = "exclude"

  /**
   * User-facing label of the picked server (or bundle child).
   * Surfaced by the Quick Settings tile as its label when the VPN
   * is running. Empty string → tile falls back to "Cloakwire".
   */
  var name: String = ""
}

@InvokeArg
class ReadLogsArgs {
  // JS side sends `maxLines`; gomobile-style parseArgs matches by
  // exact field name, so keep it identical to the frontend contract.
  var maxLines: Int = 300
}

@InvokeArg
class TestLatencyArgs {
  /** Full tester config JSON from Rust `generate_xray_test_config`. */
  var config: String = ""
  /** `[{"tag": ..., "port": ...}]` — the port→tag map. */
  var entries: String = "[]"
}

@InvokeArg
class SubscriptionFetchUrlArgs {
  var url: String = ""
  var hwid: String = ""
  var deviceOs: String = ""
}

/**
 * Tauri plugin bridging the webview to the dual-engine
 * [CloakwireVpnService] (sing-box + Xray).
 *
 * Registered from Rust, so the JS side calls `invoke("plugin:vpn|<cmd>")`
 * and subscribes with `addPluginListener("vpn", "status", cb)`.
 *
 * Commands include VPN consent, start/stop/status, app routing, active-core
 * version/log access, latency testing and Android subscription fetching.
 */
@TauriPlugin
class VpnPlugin(private val activity: Activity) : Plugin(activity) {
  override fun load(webView: WebView) {
    VpnEvents.emitter = { event, payload -> trigger(event, payload) }
  }

  override fun onDestroy() {
    VpnEvents.emitter = null
  }

  // ---- prepare ------------------------------------------------------

  @Command
  fun prepare(invoke: Invoke) {
    val intent = VpnService.prepare(activity)
    if (intent == null) {
      val ret = JSObject()
      ret.put("prepared", true)
      invoke.resolve(ret)
    } else {
      // The consent dialog result arrives in prepareResult.
      activity.runOnUiThread {
        startActivityForResult(invoke, intent, "prepareResult")
      }
    }
  }

  @ActivityCallback
  fun prepareResult(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode == Activity.RESULT_OK) {
      val ret = JSObject()
      ret.put("prepared", true)
      invoke.resolve(ret)
    } else {
      invoke.reject("VPN permission denied")
    }
  }

  // ---- start / stop ---------------------------------------------------

  @Command
  fun start(invoke: Invoke) {
    thread(name = "vpn-plugin-start") {
      try {
        if (VpnService.prepare(activity) != null) {
          invoke.reject("VPN permission not granted — call prepare first")
          return@thread
        }
        val args = invoke.parseArgs(StartArgs::class.java)

        // The full engine config must arrive pre-built (Rust side).
        if (args.config.isBlank()) {
          invoke.reject("nothing to start: config is empty")
          return@thread
        }
        // Validate before handing off: the service must never see a
        // non-JSON body.
        val engine = if (args.engine == "xray") {
          CloakwireVpnService.ENGINE_XRAY
        } else {
          CloakwireVpnService.ENGINE_SINGBOX
        }
        val engineConfig = args.config
        JSONObject(engineConfig).getJSONArray("outbounds")

        val file = CloakwireVpnService.configFile(activity)
        file.writeText(engineConfig)

        val appsMode = if (args.appsMode == "include") "include" else "exclude"
        val intent = Intent(activity, CloakwireVpnService::class.java)
          .setAction(CloakwireVpnService.ACTION_START)
          .putExtra(CloakwireVpnService.EXTRA_CONFIG_PATH, file.absolutePath)
          .putExtra(CloakwireVpnService.EXTRA_ENGINE, engine)
          .putExtra(CloakwireVpnService.EXTRA_APPS, args.apps)
          .putExtra(CloakwireVpnService.EXTRA_APPS_MODE, appsMode)
          .putExtra(CloakwireVpnService.EXTRA_SERVER_NAME, args.name)
        activity.startForegroundService(intent)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    try {
      val intent = Intent(activity, CloakwireVpnService::class.java)
        .setAction(CloakwireVpnService.ACTION_STOP)
      activity.startService(intent)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  // ---- status ---------------------------------------------------------

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(VpnEvents.statusJson())
  }

  // ---- app list (per-app routing picker) ------------------------------

  @Command
  fun listApps(invoke: Invoke) {
    thread(name = "vpn-plugin-list-apps") {
      try {
        val pm = activity.packageManager
        @Suppress("DEPRECATION")
        val installed = if (Build.VERSION.SDK_INT >= 33) {
          pm.getInstalledApplications(PackageManager.ApplicationInfoFlags.of(0))
        } else {
          pm.getInstalledApplications(0)
        }
        val items = installed
          .map { info ->
            val label = runCatching {
              pm.getApplicationLabel(info).toString()
            }.getOrDefault(info.packageName)
            val system = (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0
            @Suppress("DEPRECATION")
            val hasInternet = runCatching {
              pm.checkPermission(
                android.Manifest.permission.INTERNET,
                info.packageName
              ) == PackageManager.PERMISSION_GRANTED
            }.getOrDefault(true)
            Triple(label, info.packageName, system to hasInternet)
          }
          .sortedBy { it.first.lowercase() }

        val arr = JSArray()
        for ((label, pkg, flags) in items) {
          val obj = JSObject()
          obj.put("packageName", pkg)
          obj.put("label", label)
          obj.put("system", flags.first)
          obj.put("hasInternet", flags.second)
          arr.put(obj)
        }
        val ret = JSObject()
        ret.put("apps", arr)
        invoke.resolve(ret)
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  // ---- Android subscription HTTP transport -----------------------------

  /**
   * Subscription fetch over the Android network stack. The in-process
   * Rust reqwest/rustls client produces a ClientHello that anivka.top's
   * edge RSTs; HttpURLConnection rides BoringSSL and passes. Rust
   * owns the HWID and calls this with `url`/`hwid`/`deviceOs`; the
   * response carries the body, content type, the REAL HTTP status and
   * the provider metadata headers back for classification.
   *
   * Mirrors the desktop SubscriptionHttpClient contract: fixed
   * ClashforWindows UA, X-HWID/X-Device-OS/X-Device-Model headers,
   * HTTPS-only except loopback, 10 MiB body cap, 20 s total timeout.
   */
  @Command
  fun subscriptionFetchUrl(invoke: Invoke) {
    thread(name = "vpn-plugin-sub-fetch") {
      try {
        val args = invoke.parseArgs(SubscriptionFetchUrlArgs::class.java)
        if (args.url.isBlank()) {
          invoke.reject("subscription url is empty")
          return@thread
        }
        val url = java.net.URI(args.url).toURL()
        if (url.protocol.equals("http", true) &&
          !isLoopback(url.host)
        ) {
          invoke.reject("provider requires https")
          return@thread
        }

        val connection = url.openConnection() as java.net.HttpURLConnection
        try {
          connection.connectTimeout = 10_000
          connection.readTimeout = 20_000
          connection.instanceFollowRedirects = true
          // Our own app identity, byte-identical to the desktop client
          // that panels already trust. Remnawave panels (hat.onl)
          // whitelist the "Cloakwire/<version> (Windows)" pattern —
          // the "(Windows)" suffix is part of the registered pattern,
          // so it stays even from Android (verified 2026-08-22:
          // "(Android)" gets an empty skeleton, "(Windows)" the full
          // config). anivka accepts this UA as well.
          connection.setRequestProperty("User-Agent", desktopStyleUserAgent())
          connection.setRequestProperty("X-HWID", args.hwid)
          connection.setRequestProperty("X-Device-OS", args.deviceOs.ifBlank { "Android" })
          connection.setRequestProperty("X-Device-Model", "Cloakwire")

          val status = connection.responseCode
          if (status !in 200..299) {
            invoke.reject(httpStatusMessage(status))
            return@thread
          }
          val body = connection.inputStream.use { input ->
            readBounded(input, MAX_BODY_BYTES)
          } ?: run {
            invoke.reject("subscription body exceeds 10 MiB")
            return@thread
          }

          val ret = JSObject()
          ret.put("body", String(body, Charsets.UTF_8))
          ret.put("contentType", connection.contentType ?: "")
          ret.put("status", status)
          val headers = JSObject()
          for (name in METADATA_HEADERS) {
            val value = connection.getHeaderField(name)
            if (!value.isNullOrBlank()) headers.put(name.lowercase(), value)
          }
          ret.put("headers", headers)
          invoke.resolve(ret)
        } finally {
          connection.disconnect()
        }
      } catch (e: Exception) {
        invoke.reject(fetchErrorMessage(e))
      }
    }
  }

  /**
   * "Cloakwire/<version> (Windows)" — matches the desktop client's
   * UA exactly; see the note at the call site for why the platform
   * suffix is fixed.
   */
  private fun desktopStyleUserAgent(): String {
    val version = runCatching {
      val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
      info.versionName ?: "1.3.1"
    }.getOrDefault("1.3.1")
    return "Cloakwire/$version (Windows)"
  }

  private fun isLoopback(host: String): Boolean {
    val address = runCatching { java.net.InetAddress.getByName(host) }.getOrNull()
    return address?.isLoopbackAddress == true
  }

  /** Read up to [limit] + 1 bytes; null means the body exceeded it. */
  private fun readBounded(input: java.io.InputStream, limit: Int): ByteArray? {
    val buffer = java.io.ByteArrayOutputStream()
    val chunk = ByteArray(16 * 1024)
    var total = 0
    while (true) {
      val n = input.read(chunk)
      if (n < 0) break
      total += n
      if (total > limit) return null
      buffer.write(chunk, 0, n)
    }
    return buffer.toByteArray()
  }

  private fun httpStatusMessage(status: Int): String = when (status) {
    401, 403 -> "provider rejected the device HWID (HTTP $status)"
    404 -> "subscription not found (HTTP 404)"
    410 -> "subscription expired (HTTP 410)"
    429 -> "provider rate limit (HTTP 429)"
    in 500..599 -> "provider server error (HTTP $status)"
    else -> "subscription fetch failed (HTTP $status)"
  }

  private fun fetchErrorMessage(e: Exception): String = when (e) {
    is java.net.UnknownHostException -> "provider host not found"
    is java.net.SocketTimeoutException -> "provider timed out"
    is java.io.IOException -> "subscription fetch failed (network)"
    else -> "subscription fetch failed"
  }

  companion object {
    /** Provider metadata headers surfaced back to Rust (lowercased). */
    private val METADATA_HEADERS = listOf(
      "profile-title",
      "subscription-userinfo",
      "profile-update-interval",
      "profile-web-page-url",
    )
    private const val MAX_BODY_BYTES = 10 * 1024 * 1024
  }

  // ---- misc -----------------------------------------------------------

  @Command
  fun coreVersion(invoke: Invoke) {
    thread(name = "vpn-plugin-version") {
      try {
        val value = when (VpnEvents.activeEngine) {
          CloakwireVpnService.ENGINE_SINGBOX ->
            "sing-box ${SingBoxEngine.version(activity)}"
          CloakwireVpnService.ENGINE_XRAY ->
            "Xray ${XrayEngine.version(activity)}"
          else ->
            "sing-box ${SingBoxEngine.version(activity)} / Xray ${XrayEngine.version(activity)}"
        }
        invoke.resolve(JSObject().put("value", value))
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  @Command
  fun readLogs(invoke: Invoke) {
    thread(name = "vpn-plugin-logs") {
      try {
        val args = invoke.parseArgs(ReadLogsArgs::class.java)
        val file = CloakwireVpnService.activeLogFile(activity)
        val text = if (file.exists()) {
          file.readLines()
            .takeLast(args.maxLines.coerceIn(1, 2000))
            .joinToString("\n")
        } else {
          ""
        }
        invoke.resolve(JSObject().put("value", text))
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }
}
