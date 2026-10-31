package app.cloakwire.client.vpn

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.VpnService
import android.os.Build
import android.util.Base64
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.cloakwire.client.widget.CloakwireWidgetUpdater
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
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.concurrent.thread

@InvokeArg
class SetAccentArgs {
  var accent: String = "emerald"
}

@InvokeArg
class CancelProfilePreparationArgs { var preparationId:String="" }

@InvokeArg
class SetRecoveryArgs { var enabled:Boolean=false }

@InvokeArg
class ProbeArgs { var source:String="";var operationId:String="";var engine:String="";var config:String="";var tag:String="";var issue:String="" }

@InvokeArg
class StartArgs {
  var preparationId: String = ""
  var source: String = ""
  var expectedRunId: String = ""
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

  /** Kill switch mode: "off", "on_drop", or "always_on". */
  var killSwitch: String = "on_drop"

  /** IPv6 blocking toggle. */
  var blockIpv6: Boolean = true
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
    ProbeCoordinator.initialize(activity)
    ProbeCoordinator.emitter = { trigger("probe",it) }
  }

  override fun onDestroy() {
    VpnEvents.emitter = null
    ProbeCoordinator.emitter = null
  }

  @Command fun probe(invoke:Invoke) {
    try{val args=invoke.parseArgs(ProbeArgs::class.java);val source=ProfileSource.parse(args.source)?:error("unsupported_probe")
      val health=ProbeCoordinator.begin(source);invoke.resolve(JSObject().put("operation_id",health.operationId) as JSObject)
    }catch(_:Exception){invoke.reject("unsupported_probe")}
  }
  @Command fun cancelProbe(invoke:Invoke){val args=invoke.parseArgs(ProbeArgs::class.java);ProbeCoordinator.cancel(args.operationId);invoke.resolve()}
  @Command fun probeSnapshot(invoke:Invoke){invoke.resolve(ProbeCoordinator.snapshot())}
  // Not in the WebView capability: only the trusted Rust source preparer calls this command.
  @Command fun runProbe(invoke:Invoke){
    try{val args=invoke.parseArgs(ProbeArgs::class.java);val source=ProfileSource.parse(args.source)?:error("unsupported_probe")
      ProbeCoordinator.submit(args.operationId,source,args.engine,args.config,args.tag);invoke.resolve()
    }catch(_:Exception){invoke.reject("profile_check_cancelled")}
  }
  @Command fun failProbe(invoke:Invoke){
    val args=invoke.parseArgs(ProbeArgs::class.java)
    ProbeCoordinator.fail(args.operationId,HealthIssue.UNSUPPORTED_PROBE);invoke.resolve()
  }

  @Command fun setRecoveryEnabled(invoke:Invoke) {
    val enabled=try{invoke.parseArgs(SetRecoveryArgs::class.java).enabled}catch(_:Exception){invoke.reject("recovery_setting_failed");return}
    // Opt-out invalidates pending native work before waiting for disk I/O.
    val ticket=NativeRecoveryPreferences.writer.begin(enabled){value->CloakwireVpnService.active?.setRecoveryEnabled(value)}
    thread(name="vpn-recovery-setting") {
      try {
        NativeRecoveryPreferences.writer.commit(ticket,{value->
          activity.getSharedPreferences("cloakwire_state",Context.MODE_PRIVATE).edit()
            .putBoolean(CloakwireVpnService.KEY_RECOVERY_ENABLED,value).commit()
        }){value->CloakwireVpnService.active?.setRecoveryEnabled(value)}
        invoke.resolve()
      }catch(_:Exception){invoke.reject("recovery_setting_failed")}
    }
  }
  @Command fun recoveryStatus(invoke:Invoke) {
    val live=CloakwireVpnService.active
    val status=live?.recoveryStatus()?:JSObject().put("enabled",activity.getSharedPreferences("cloakwire_state",Context.MODE_PRIVATE).getBoolean(CloakwireVpnService.KEY_RECOVERY_ENABLED,false))
      .put("phase","idle").put("attempts",0).put("issue",JSONObject.NULL).put("run_id",JSONObject.NULL) as JSObject
    invoke.resolve(status)
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
    ProbeCoordinator.invalidate()
    val args:StartArgs
    val request:Long
    try {
      args=invoke.parseArgs(StartArgs::class.java)
      request=if(args.preparationId.isNotEmpty())args.preparationId.toLong() else AndroidProfilePreflight.starts.begin()
      if(!AndroidProfilePreflight.starts.isCurrent(request))throw ProfileCheckException(ProfileCheckKind.CANCELLED)
      CloakwireVpnService.active?.pauseRecoveryForStart(request)
    }catch(error:Exception){invoke.reject(ProfilePreflight.failure(error).message?:ProfileCheckKind.FAILED.token);return}
    thread(name = "vpn-plugin-start") {
      var errorContext="stopped"
      var source:ProfileSource?=null
      try {
        if (VpnService.prepare(activity) != null) {
          CloakwireVpnService.active?.resumeRecoveryAfterRejectedStart(request)
          invoke.reject("VPN permission not granted — call prepare first")
          return@thread
        }
        if(!AndroidProfilePreflight.starts.isCurrent(request))throw ProfileCheckException(ProfileCheckKind.CANCELLED)
        errorContext=args.expectedRunId.ifEmpty { VpnEvents.currentRun() }
        source=ProfileSource.parse(args.source)
        if(!VpnEvents.matchesRun(args.expectedRunId))throw IllegalStateException("profile_source_changed")
        if(AndroidProfilePreflight.starts.isCurrent(request))VpnEvents.recordCheck(source,"checking",context=errorContext)

        val engine = if (args.engine == "xray") {
          CloakwireVpnService.ENGINE_XRAY
        } else {
          CloakwireVpnService.ENGINE_SINGBOX
        }
        val appsMode = if (args.appsMode == "include") "include" else "exclude"
        ProfilePreflight.run(
          prepare = { AndroidProfilePreflight.prepare(activity, args.config, engine, args.apps, appsMode) },
          check = { AndroidProfilePreflight.check(activity, it, engine) },
          handoff = { config ->
            AndroidProfilePreflight.starts.handoff(request) {
              if(!VpnEvents.matchesRun(args.expectedRunId))throw IllegalStateException("profile_source_changed")
              VpnEvents.recordCheck(source,"passed",context=errorContext)
              // Unique checked snapshots prevent overlapping starts from replacing
              // each other's config, and leave the last session untouched on rejection.
              val file = File.createTempFile("vpn-checked-", ".json", activity.cacheDir)
              try {
                file.writeText(config)
                val intent = Intent(activity, CloakwireVpnService::class.java)
                  .setAction(CloakwireVpnService.ACTION_START)
                  .putExtra(CloakwireVpnService.EXTRA_CONFIG_PATH, file.absolutePath)
                  .putExtra(CloakwireVpnService.EXTRA_PREFLIGHTED, true)
                  .putExtra(CloakwireVpnService.EXTRA_START_REQUEST,request)
                  .putExtra(CloakwireVpnService.EXTRA_PROFILE_SOURCE, source?.toJson()?.toString().orEmpty())
                  .putExtra(CloakwireVpnService.EXTRA_EXPECTED_RUN, args.expectedRunId)
                  .putExtra(CloakwireVpnService.EXTRA_ENGINE, engine)
                  .putExtra(CloakwireVpnService.EXTRA_APPS, args.apps)
                  .putExtra(CloakwireVpnService.EXTRA_APPS_MODE, appsMode)
                  .putExtra(CloakwireVpnService.EXTRA_SERVER_NAME, args.name)
                  .putExtra(CloakwireVpnService.EXTRA_KILL_SWITCH, args.killSwitch)
                  .putExtra(CloakwireVpnService.EXTRA_BLOCK_IPV6, args.blockIpv6)
                activity.startForegroundService(intent)
              } catch (error: Exception) {
                file.delete()
                throw error
              }
            }
          },
        )
        invoke.resolve()
      } catch (error: Exception) {
        CloakwireVpnService.active?.resumeRecoveryAfterRejectedStart(request)
        if (AndroidProfilePreflight.starts.isCurrent(request)) {
          val safe=ProfilePreflight.failure(error).message ?: ProfileCheckKind.FAILED.token
          VpnEvents.recordCheck(source,"failed",safe,errorContext)
          invoke.reject(safe)
        } else {
          invoke.reject(ProfileCheckKind.CANCELLED.token)
        }
      } catch (_: LinkageError) {
        CloakwireVpnService.active?.resumeRecoveryAfterRejectedStart(request)
        if (AndroidProfilePreflight.starts.isCurrent(request)) {VpnEvents.recordCheck(source,"failed",ProfileCheckKind.UNAVAILABLE.token,errorContext);invoke.reject(ProfileCheckKind.UNAVAILABLE.token)}
        else invoke.reject(ProfileCheckKind.CANCELLED.token)
      }
    }
  }

  @Command fun beginProfilePreparation(invoke:Invoke) {
    ProbeCoordinator.invalidate()
    val request=AndroidProfilePreflight.starts.begin()
    CloakwireVpnService.active?.pauseRecoveryForStart(request)
    val result=JSObject();result.put("request",request.toString());invoke.resolve(result)
  }
  @Command fun cancelProfilePreparation(invoke:Invoke) {
    try {
      val args=invoke.parseArgs(CancelProfilePreparationArgs::class.java)
      val request=args.preparationId.toLongOrNull()?:throw ProfileCheckException(ProfileCheckKind.CANCELLED)
      try {
        AndroidProfilePreflight.starts.handoff(request) {
          AndroidProfilePreflight.starts.cancel()
          CloakwireVpnService.active?.resumeRecoveryAfterRejectedStart(request)
        }
      }catch(_:ProfileCheckException){ /* A newer request or Stop already owns the intent. */ }
      invoke.resolve()
    }catch(error:Exception){invoke.reject(ProfilePreflight.failure(error).message?:ProfileCheckKind.CANCELLED.token)}
  }
  @Command fun invalidateProfileStarts(invoke:Invoke) {
    ProbeCoordinator.invalidate()
    AndroidProfilePreflight.starts.cancel()
    CloakwireVpnService.active?.releaseRecoveryPreparation()
    invoke.resolve(JSObject())
  }
  @Command
  fun stop(invoke: Invoke) {
    CloakwireVpnService.active?.cancelRecoveryIntent()
    ProbeCoordinator.invalidate()
    AndroidProfilePreflight.starts.cancel()
    try {
      val intent = Intent(activity, CloakwireVpnService::class.java)
        .setAction(CloakwireVpnService.ACTION_STOP)
        .putExtra(CloakwireVpnService.EXTRA_PENDING_START_CANCELLED, true)
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
          obj.put("icon", appIconDataUrl(pm, pkg))
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

  /** Rasterize bitmap, vector and adaptive icons at a bounded size for the WebView. */
  private fun appIconDataUrl(pm: PackageManager, packageName: String): String? =
    runCatching {
      val drawable = pm.getApplicationIcon(packageName)
      val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
      try {
        drawable.setBounds(0, 0, bitmap.width, bitmap.height)
        drawable.draw(Canvas(bitmap))
        ByteArrayOutputStream().use { output ->
          bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
          "data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        }
      } finally {
        bitmap.recycle()
      }
    }.getOrNull()

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

  @Command
  fun setAccentTheme(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SetAccentArgs::class.java)
      activity.getSharedPreferences("cloakwire_state", Context.MODE_PRIVATE)
        .edit().putString("accent_theme", args.accent).apply()
      CloakwireWidgetUpdater.updateAllWidgets(activity)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  @Command
  fun readClipboard(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val clip = clipboard?.primaryClip
        val text = if (clip != null && clip.itemCount > 0) {
          clip.getItemAt(0)?.coerceToText(activity)?.toString() ?: ""
        } else {
          ""
        }
        invoke.resolve(JSObject().put("value", text))
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Failed to read clipboard")
      }
    }
  }
}
