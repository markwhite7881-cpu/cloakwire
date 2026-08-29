package app.cloakwire.client.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import app.cloakwire.client.R
import java.io.File
import kotlin.concurrent.thread

/**
 * Foreground [VpnService] hosting either sing-box or Xray.
 *
 * sing-box runs in-process through libbox and [CloakwirePlatform], which
 * establishes the Android TUN and protects outbound sockets.
 *
 * Xray keeps the loop-safe v2rayNG-style path:
 * apps -> TUN -> hev-socks5-tunnel -> Xray SOCKS inbound ->
 * [ProtectedSocks5Proxy] -> protect() -> physical network.
 *
 * The selected engine, config, app-routing policy and friendly server name
 * are persisted for sticky service and Quick Settings restarts. Any startup
 * failure tears down the complete active path before reporting STATE_ERROR.
 * Unexpected Xray exits use a bounded restart policy; libbox lifecycle
 * failures arrive through [SingBoxEngine]'s command-server callbacks.
 */
class CloakwireVpnService : VpnService() {

  companion object {
    const val ACTION_START = "app.cloakwire.client.START"
    const val ACTION_STOP = "app.cloakwire.client.STOP"
    const val EXTRA_CONFIG_PATH = "configPath"
    const val EXTRA_APPS = "apps"
    const val EXTRA_APPS_MODE = "appsMode"
    /** Friendly server label supplied by the JS side. The Quick Settings
     *  tile uses this as its label. */
    const val EXTRA_SERVER_NAME = "serverName"
    const val EXTRA_ENGINE = "engine"
    const val ENGINE_SINGBOX = "sing-box"
    const val ENGINE_XRAY = "xray"

    /** xray socks inbound (loopback). Must match the config builder. */
    const val SOCKS_INBOUND_PORT = 10808
    /** In-app protected SOCKS5 dialer (loopback). */
    const val PROTECTED_PROXY_PORT = 10810
    const val TUN_ADDRESS = "10.0.0.2"
    const val TUN_MTU = 8500

    private const val TAG = "CloakwireVpnService"
    private const val NOTIFICATION_ID = 1
    private const val CHANNEL_ID = "cloakwire_vpn"
    private const val MAX_ENGINE_RESTARTS = 2
    private const val ENGINE_RESTART_DELAY_MS = 1_500L
    private const val PREFS = "cloakwire_state"
    private const val KEY_LAST_SERVER = "last_server_name"
    private const val KEY_LAST_ENGINE = "last_engine"
    private const val KEY_LAST_APPS = "last_apps"
    private const val KEY_LAST_APPS_MODE = "last_apps_mode"
    private const val KEY_IS_CONNECTED = "is_user_connected"

    /** Live service instance (null while stopped). */
    @Volatile var active: CloakwireVpnService? = null
      private set

    /**
     * Display name of the active server supplied by the frontend or
     * derived from the active engine config. Read by the Quick Settings
     * tile. Empty when no session is running.
     */
    @Volatile var activeServerName: String = ""
      private set

    /** Persisted last-session engine config; sticky restart reads it. */
    fun configFile(context: android.content.Context): File {
      val xray = File(context.filesDir, "xray-config.json")
      if (xray.exists() && xray.length() > 0) return xray
      val configJson = File(context.filesDir, "configuration.json")
      if (configJson.exists() && configJson.length() > 0) return configJson
      return xray
    }

    fun logFile(context: android.content.Context): File =
      File(File(context.filesDir, "xray"), "xray.log")

    fun singboxLogFile(context: android.content.Context): File =
      File(File(context.filesDir, "singbox"), "box.log")

    fun lastEngine(context: android.content.Context): String =
      context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        .getString(KEY_LAST_ENGINE, ENGINE_SINGBOX) ?: ENGINE_SINGBOX

    fun activeLogFile(context: android.content.Context): File {
      val engine = VpnEvents.activeEngine.ifBlank { lastEngine(context) }
      return if (engine == ENGINE_SINGBOX) singboxLogFile(context) else logFile(context)
    }
  }

  private val protectedProxy = ProtectedSocks5Proxy(this, PROTECTED_PROXY_PORT)
  private val tun2socks = Tun2SocksService(this)
  private var xrayEngine: XrayEngine? = null
  private var singBoxEngine: SingBoxEngine? = null

  /** Session-scoped TUN descriptor; the service is the sole owner. */
  @Volatile private var tunPfd: ParcelFileDescriptor? = null
  @Volatile private var sessionActive = false
  @Volatile private var engineRestarts = 0
  @Volatile private var starting = false

  /** Called by CloakwirePlatform after libbox establishes its TUN. */
  fun onTunEstablished(pfd: ParcelFileDescriptor) {
    tunPfd = pfd
  }

  fun mainActivityPendingIntent(): PendingIntent {
    val intent = packageManager.getLaunchIntentForPackage(packageName)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
    return PendingIntent.getActivity(this, 0, intent, flags)
  }

  override fun onCreate() {
    super.onCreate()
    active = this
    createNotificationChannel()
    // Wake the Quick Settings tile on every state transition so it
    // re-reads [VpnEvents] / [activeServerName] without the service
    // having to notify it at each of the 10 update() call sites.
    VpnEvents.setStateChangeListener { QuickTileService.notifyStateChanged(this) }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopVpn()
        return START_NOT_STICKY
      }
      ACTION_START -> {
        val configPath = intent.getStringExtra(EXTRA_CONFIG_PATH)
        if (configPath.isNullOrEmpty()) {
          VpnEvents.update(VpnEvents.STATE_ERROR, "missing config path")
          stopSelf()
          return START_NOT_STICKY
        }
        val prefs = getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        val apps = intent.getStringExtra(EXTRA_APPS)
          ?: prefs.getString(KEY_LAST_APPS, "[]")
          ?: "[]"
        val appsMode = intent.getStringExtra(EXTRA_APPS_MODE)
          ?: prefs.getString(KEY_LAST_APPS_MODE, "exclude")
          ?: "exclude"
        val serverName = intent.getStringExtra(EXTRA_SERVER_NAME).orEmpty()
        val engine = intent.getStringExtra(EXTRA_ENGINE)
          ?: prefs.getString(KEY_LAST_ENGINE, ENGINE_SINGBOX)
          ?: ENGINE_SINGBOX
        acceptStart(configPath, apps, appsMode, serverName, engine)
        return START_STICKY
      }
      else -> {
        // Process restarted by the system with no intent. Resume the
        // persisted session ONLY if the user was actively connected; otherwise stay stopped.
        val prefs = getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        val wasConnected = prefs.getBoolean(KEY_IS_CONNECTED, false)
        val persisted = configFile(this)
        if (wasConnected && persisted.exists() && !sessionActive) {
          val engine = prefs.getString(KEY_LAST_ENGINE, ENGINE_SINGBOX) ?: ENGINE_SINGBOX
          val apps = prefs.getString(KEY_LAST_APPS, "[]") ?: "[]"
          val appsMode = prefs.getString(KEY_LAST_APPS_MODE, "exclude") ?: "exclude"
          acceptStart(persisted.absolutePath, apps, appsMode, engine = engine)
          return START_STICKY
        }
        if (!sessionActive) {
          VpnEvents.update(VpnEvents.STATE_STOPPED)
          stopSelf()
        }
        return START_NOT_STICKY
      }
    }
  }

  private fun acceptStart(
    configPath: String,
    apps: String,
    appsMode: String,
    serverName: String = "",
    engine: String = ENGINE_XRAY,
  ) {
    val selectedEngine = if (engine == ENGINE_SINGBOX) ENGINE_SINGBOX else ENGINE_XRAY
    val selectedApps = apps.ifBlank { "[]" }
    val selectedAppsMode = if (appsMode == "include") "include" else "exclude"
    VpnEvents.setEngine(selectedEngine)
    getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_IS_CONNECTED, true)
      .putString(KEY_LAST_ENGINE, selectedEngine)
      .putString(KEY_LAST_APPS, selectedApps)
      .putString(KEY_LAST_APPS_MODE, selectedAppsMode)
      .apply()
    // Surface the active server name to the Quick Settings tile as
    // early as possible. The JS side passes it as EXTRA_SERVER_NAME;
    // we fall back to parsing the xray config only if the caller
    // didn't supply one (sticky restart from the tile has no extras).
    val resolvedName = serverName.ifBlank {
      getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        .getString(KEY_LAST_SERVER, "")
        .orEmpty()
        .ifBlank { extractProxyOutboundTag(configPath).orEmpty() }
    }
    activeServerName = resolvedName
    if (resolvedName.isNotEmpty()) {
      // Persist for the Quick Settings tile label so it survives
      // accidental deletion of the xray-config.json.
      getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_LAST_SERVER, resolvedName)
        .apply()
    }
    // Foreground must be entered quickly after startForegroundService,
    // before any heavy work.
    startForegroundWith("Connecting…")
    VpnEvents.update(VpnEvents.STATE_STARTING)
    if (starting || sessionActive) {
      // A new session replaces the old one: tear down first.
      runCatching { teardownComponents() }
    }
    starting = true
    thread(name = "vpn-start") {
      try {
        runVpn(configPath, selectedApps, selectedAppsMode, selectedEngine)
        VpnEvents.update(VpnEvents.STATE_RUNNING)
        startForegroundWith("Connected")
      } catch (e: Exception) {
        Log.e(TAG, "VPN start failed", e)
        val message = e.message ?: e.toString()
        VpnEvents.update(VpnEvents.STATE_ERROR, message)
        runCatching { teardownComponents() }
        stopForeground(true)
        stopSelf()
      } finally {
        starting = false
      }
    }
  }

  private fun runVpn(configPath: String, apps: String, appsMode: String, engine: String) {
    if (engine == ENGINE_SINGBOX) {
      runSingBoxVpn(configPath, apps, appsMode)
      return
    }
    runXrayVpn(configPath, apps, appsMode)
  }

  private fun runXrayVpn(configPath: String, apps: String, appsMode: String) {
    // 1. Config: normalize + inject the log output path so the UI can
    //    tail the (redacted) xray log.
    val raw = File(configPath).readText()
    val config = injectLogOutput(raw)
    logOutboundTopology(config)
    // Persist the normalized config for sticky restarts.
    runCatching {
      configFile(this).writeText(config)
    }

    // 2. TUN — the service owns the descriptor for the whole session.
    val pfd = establishTun(apps, appsMode)
    tunPfd = pfd

    // 3. Protected dialer. Started only after the TUN exists so
    //    protect() operates on a live VPN session.
    protectedProxy.start()

    // 4. xray sidecar (readiness-checked; throws with the sanitized
    //    tail of the engine log if the config is rejected).
    val engine = XrayEngine(this, ::onEngineDied)
    engine.start(config)
    xrayEngine = engine

    // 5. hev-socks5-tunnel: TUN fd → xray socks inbound. Uses the
    //    live descriptor (NOT detached); we close it after stopping
    //    the tunnel.
    val wired = tun2socks.start(pfd, SOCKS_INBOUND_PORT, TUN_MTU, TUN_ADDRESS)
    if (!wired) {
      throw IllegalStateException("tun2socks failed to start")
    }
    sessionActive = true
    engineRestarts = 0
    startTrafficPoller()
  }

  /** Start the in-process libbox engine. CloakwirePlatform owns TUN setup. */
  private fun runSingBoxVpn(configPath: String, apps: String, appsMode: String) {
    val raw = File(configPath).readText()
    val config = prepareSingBoxConfig(raw, apps, appsMode)
    configFile(this).writeText(config)

    val engine = SingBoxEngine(this, ::onSingBoxDied)
    singBoxEngine = engine
    engine.start(config)
    check(tunPfd != null) { "sing-box did not establish a TUN interface" }
    sessionActive = true
    engineRestarts = 0
  }

  /** Ensure provider sing-box bundles have an Android TUN and app policy. */
  private fun prepareSingBoxConfig(raw: String, appsJson: String, appsMode: String): String {
    val root = JSONObject(raw)
    val inbounds = root.optJSONArray("inbounds") ?: JSONArray().also {
      root.put("inbounds", it)
    }
    var existing: JSONObject? = null
    for (i in 0 until inbounds.length()) {
      val candidate = inbounds.optJSONObject(i) ?: continue
      if (candidate.optString("type") == "tun") {
        existing = candidate
        break
      }
    }
    val tun = existing ?: JSONObject().also { inbounds.put(it) }
    // A provider bundle may carry a desktop-oriented TUN. Preserve its tag
    // (route rules can reference it), but normalize every Android-owned field.
    tun.put("type", "tun")
    if (tun.optString("tag").isBlank()) tun.put("tag", "tun-in")
    tun.remove("inet4_address")
    tun.remove("inet6_address")
    tun.put("address", JSONArray().put("172.19.0.1/30"))
    tun.put("auto_route", true)
    tun.put("strict_route", false)
    tun.put("stack", "gvisor")
    tun.put("mtu", 9000)
    tun.put("endpoint_independent_nat", false)
    tun.put("udp_timeout", "5m")
    tun.put("interface_name", "singbox-tun")

    tun.remove("include_package")
    tun.remove("exclude_package")
    val packages = parseAppList(appsJson).filterNot { it == packageName }
    if (packages.isNotEmpty()) {
      val values = JSONArray().also { arr -> packages.forEach { arr.put(it) } }
      if (appsMode == "include") tun.put("include_package", values)
      else tun.put("exclude_package", values)
    }

    // Ensure route has hijack-dns and private IP bypass, and clean up any legacy rules
    val route = root.optJSONObject("route") ?: JSONObject().also { root.put("route", it) }
    val rawRules = route.optJSONArray("rules") ?: JSONArray().also { route.put("rules", it) }
    val newRules = JSONArray()
    var hasHijack = false
    var hasPrivate = false

    // Clean existing rules
    for (i in 0 until rawRules.length()) {
      val r = rawRules.optJSONObject(i) ?: continue
      if (r.optString("network") == "dns") {
        r.remove("network")
        r.put("action", "hijack-dns")
        r.put("port", JSONArray().put(53))
        hasHijack = true
        newRules.put(r)
        continue
      }
      if (r.optString("action") == "hijack-dns") hasHijack = true
      if (r.optBoolean("ip_is_private")) hasPrivate = true
      newRules.put(r)
    }

    // Prepend hijack-dns and private bypass if missing
    val finalRules = JSONArray()
    if (!hasHijack) {
      finalRules.put(JSONObject().put("action", "hijack-dns").put("port", JSONArray().put(53)))
    }
    if (!hasPrivate) {
      finalRules.put(JSONObject().put("action", "route").put("ip_is_private", true).put("outbound", "direct"))
    }
    for (i in 0 until newRules.length()) {
      finalRules.put(newRules.get(i))
    }
    route.put("rules", finalRules)

    val log = root.optJSONObject("log") ?: JSONObject().also { root.put("log", it) }
    val file = singboxLogFile(this)
    file.parentFile?.mkdirs()
    if (file.exists()) file.delete()
    log.put("output", file.absolutePath)
    if (!log.has("level")) log.put("level", "info")
    return root.toString()
  }

  private fun onSingBoxDied(message: String) {
    if (sessionActive) failSession(message)
  }

  /**
   * 1 Hz traffic feed from the tun2socks byte counters — the Android
   * replacement for the desktop Clash-API poller. hev reports
   * cumulative [txPackets, txBytes, rxPackets, rxBytes]; tx is the
   * device→internet direction (upload).
   */
  @Volatile private var trafficThread: Thread? = null

  private fun startTrafficPoller() {
    stopTrafficPoller()
    trafficThread = thread(name = "vpn-traffic-stats", isDaemon = true) {
      var lastTx = -1L
      var lastRx = -1L
      var lastAt = System.currentTimeMillis()
      while (sessionActive) {
        try {
          Thread.sleep(1_000)
        } catch (_: InterruptedException) {
          // stopTrafficPoller interrupts us on reconnect/teardown —
          // an uncaught InterruptedException here is a FATAL that
          // kills the whole app (seen on-device 2026-08-22).
          Thread.currentThread().interrupt()
          break
        }
        if (!sessionActive) break
        val stats = tun2socks.getStats() ?: continue
        if (stats.size < 4) continue
        val tx = stats[1]
        val rx = stats[3]
        val now = System.currentTimeMillis()
        if (lastTx >= 0 && now > lastAt) {
          val dt = (now - lastAt) / 1000.0
          val up = ((tx - lastTx).coerceAtLeast(0) / dt).toLong()
          val down = ((rx - lastRx).coerceAtLeast(0) / dt).toLong()
          VpnEvents.emitTraffic(up, down, tx, rx)
        }
        lastTx = tx
        lastRx = rx
        lastAt = now
      }
    }
  }

  private fun stopTrafficPoller() {
    trafficThread?.interrupt()
    trafficThread = null
  }

  /**
   * Establish the one and only TUN interface. Per-app routing is
   * applied here (include → only these packages traverse the VPN,
   * exclude → everything except these), and our own package is ALWAYS
   * excluded so xray / the protected proxy / the WebView never route
   * their own sockets into the tunnel.
   */
  private fun establishTun(appsJson: String, appsMode: String): ParcelFileDescriptor {
    val builder = Builder()
      .setSession("Cloakwire")
      .setMtu(TUN_MTU)
      .addAddress(TUN_ADDRESS, 30)
      .addDnsServer("1.1.1.1")
      .addDnsServer("8.8.8.8")
      .addRoute("0.0.0.0", 0)
      .addRoute("::", 0)
      .setConfigureIntent(mainActivityPendingIntent())

    // Android exposes mutually exclusive allow and deny lists. In include
    // mode our own package is already outside the allow-list; adding it to
    // the deny-list as well would invalidate the policy and make the OS fall
    // back to an all-apps VPN on some vendor builds.
    val policy = XrayAppRoutingPolicy.create(
      parseAppList(appsJson),
      appsMode,
      packageName,
    )
    Log.i(
      TAG,
      "Xray app routing: mode=$appsMode allowed=${policy.allowedPackages.size} " +
        "disallowed=${policy.disallowedPackages.size}",
    )

    var appliedAllowed = 0
    for (pkg in policy.allowedPackages) {
      try {
        builder.addAllowedApplication(pkg)
        appliedAllowed += 1
      } catch (e: PackageManager.NameNotFoundException) {
        Log.w(TAG, "Skipping missing allowed package: $pkg")
      }
    }
    check(policy.allowedPackages.isEmpty() || appliedAllowed > 0) {
      "None of the selected apps are installed"
    }

    for (pkg in policy.disallowedPackages) {
      try {
        builder.addDisallowedApplication(pkg)
      } catch (e: PackageManager.NameNotFoundException) {
        Log.w(TAG, "Skipping missing disallowed package: $pkg")
      }
    }

    return builder.establish()
      ?: throw IllegalStateException(
        "VpnService.Builder.establish() returned null — VPN permission revoked?"
      )
  }

  private fun parseAppList(appsJson: String): List<String> {
    return try {
      val arr = JSONArray(appsJson)
      List(arr.length()) { i -> arr.optString(i) }
        .filter { it.isNotBlank() }
        .distinct()
    } catch (e: Exception) {
      Log.w(TAG, "ignoring invalid app list", e)
      emptyList()
    }
  }

  /**
   * Log the sanitized topology of the session config — per outbound:
   * tag, protocol, and whether the protected chain is attached. No
   * addresses, credentials or provider data. This is the evidence
   * needed to debug routing on-device (2026-08-22).
   */
  private fun logOutboundTopology(configJson: String) {
    runCatching {
      val root = JSONObject(configJson)
      val outbounds = root.optJSONArray("outbounds") ?: return
      val sb = StringBuilder("outbounds:")
      for (i in 0 until outbounds.length()) {
        val ob = outbounds.optJSONObject(i) ?: continue
        val tag = ob.optString("tag", "?")
        val protocol = ob.optString("protocol", "?")
        val chain = ob.optJSONObject("streamSettings")
          ?.optJSONObject("sockopt")
          ?.optString("dialerProxy")
          .takeUnless { it.isNullOrEmpty() } ?: "none"
        sb.append(" [").append(tag).append('/').append(protocol)
          .append("/chain=").append(chain).append(']')
      }
      Log.i(TAG, sb.toString())
      root.optJSONArray("inbounds")?.let { ins ->
        val tags = (0 until ins.length()).joinToString(",") { j ->
          ins.optJSONObject(j)?.optString("tag", "?") ?: "?"
        }
        Log.i(TAG, "inbounds: $tags")
      }
    }
  }

  /** Route xray's log output to the file the UI tails. */
  private fun injectLogOutput(configContent: String): String {
    return try {
      val json = JSONObject(configContent)
      val log = json.optJSONObject("log") ?: JSONObject().also { json.put("log", it) }
      val file = logFile(this)
      file.parentFile?.mkdirs()
      if (file.exists()) file.delete()
      log.put("output", file.absolutePath)
      // "info" surfaces outbound dial targets + accepted connections —
      // the evidence needed to debug routing decisions on-device.
      // Lines pass through XrayLogRedactor before they reach this
      // file or logcat.
      log.put("loglevel", log.optString("loglevel", "info"))
      json.toString()
    } catch (e: Exception) {
      Log.w(TAG, "log injection failed, using config as-is", e)
      configContent
    }
  }

  /**
   * The xray process died unexpectedly. Restart it (bounded); when the
   * budget is exhausted, error the session out — a dead engine with a
   * live TUN would black-hole all captured traffic.
   */
  private fun onEngineDied(exitCode: Int) {
    if (!sessionActive) return
    val engine = xrayEngine
    val config = runCatching { configFile(this).readText() }.getOrNull()
    if (engine == null || config.isNullOrEmpty()) {
      failSession("engine exited (code=$exitCode)")
      return
    }
    if (engineRestarts >= MAX_ENGINE_RESTARTS) {
      failSession("engine exited repeatedly (code=$exitCode)")
      return
    }
    engineRestarts++
    Log.w(TAG, "engine died (code=$exitCode) — restarting ($engineRestarts/$MAX_ENGINE_RESTARTS)")
    VpnEvents.update(VpnEvents.STATE_STARTING, "reconnecting")
    thread(name = "vpn-engine-restart") {
      Thread.sleep(ENGINE_RESTART_DELAY_MS)
      if (!sessionActive) return@thread
      try {
        engine.start(config)
        VpnEvents.update(VpnEvents.STATE_RUNNING)
      } catch (e: Exception) {
        failSession(e.message ?: "engine restart failed")
      }
    }
  }

  private fun failSession(message: String) {
    VpnEvents.update(VpnEvents.STATE_ERROR, message)
    getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_IS_CONNECTED, false)
      .apply()
    runCatching { teardownComponents() }
    stopForeground(true)
    stopSelf()
  }

  @Synchronized
  fun stopVpn() {
    sessionActive = false
    activeServerName = ""
    VpnEvents.setEngine("")
    VpnEvents.update(VpnEvents.STATE_STOPPED)
    getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_IS_CONNECTED, false)
      .apply()
    teardownComponents()
    stopForeground(true)
    stopSelf()
  }

  /**
   * Tear the session down in reverse start order. Synchronized so a
   * restart-of-session and a stop never interleave.
   */
  @Synchronized
  private fun teardownComponents() {
    sessionActive = false
    stopTrafficPoller()
    runCatching { tun2socks.stop() }
    xrayEngine?.let { runCatching { it.closeBestEffort() } }
    xrayEngine = null
    singBoxEngine?.let { runCatching { it.closeBestEffort() } }
    singBoxEngine = null
    runCatching { protectedProxy.stop() }
    tunPfd?.let { runCatching { it.close() } }
    tunPfd = null
  }

  override fun onDestroy() {
    // The system can kill the service without ACTION_STOP (revoke,
    // always-on change, task removal) — make sure everything goes down.
    teardownComponents()
    active = null
    activeServerName = ""
    VpnEvents.setStateChangeListener(null)
    if (VpnEvents.state != VpnEvents.STATE_STOPPED) {
      VpnEvents.update(VpnEvents.STATE_STOPPED)
    }
    super.onDestroy()
  }

  override fun onRevoke() {
    Log.i(TAG, "VPN permission revoked by the system")
    stopVpn()
    super.onRevoke()
  }

  // ---- Notification ---------------------------------------------------

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "VPN status",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Shown while the Cloakwire VPN is active"
        setShowBadge(false)
      }
      getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }
  }

  private fun startForegroundWith(text: String) {
    val notification = buildNotification(text)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(text: String): Notification {
    val stopIntent = PendingIntent.getService(
      this, 0,
      Intent(this, CloakwireVpnService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
    )
    val builder = if (Build.VERSION.SDK_INT >= 26) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    val title = if (text == "Connected") {
      if (activeServerName.isNotBlank()) "Cloakwire • $activeServerName" else "Cloakwire • Connected"
    } else {
      "Cloakwire"
    }
    val contentText = if (text == "Connected") {
      val engineLabel = if (VpnEvents.activeEngine == ENGINE_XRAY || VpnEvents.activeEngine == "xray") "Xray Core" else "sing-box"
      "Protected via $engineLabel"
    } else {
      text
    }
    return builder
      .setContentTitle(title)
      .setContentText(contentText)
      .setSmallIcon(R.drawable.ic_vpn_key)
      .setContentIntent(mainActivityPendingIntent())
      .setOngoing(true)
      .addAction(
        Notification.Action.Builder(null, "Disconnect", stopIntent).build()
      )
      .build()
  }

  /**
   * Best-effort: pull the first proxy outbound's `tag` out of the
   * xray config so the Quick Settings tile can show a useful label.
   * Returns null if the file is missing, unreadable, JSON-bad, or the
   * config has no vless/vmess/trojan/shadowsocks/http/socks outbound.
   * The protected SOCKS dialer ("protected") and direct/block are
   * skipped — they're not what the user picked.
   *
   * If the tag is the xray-core default placeholder ("proxy"), fall
   * back to `host:port` from the outbound's settings — at least the
   * tile then shows the actual VPN endpoint (e.g. "1.2.3.4:443")
   * instead of the unhelpful internal tag.
   */
  private fun extractProxyOutboundTag(configPath: String): String? {
    return try {
      val file = File(configPath)
      if (!file.exists()) return null
      val outbounds = JSONObject(file.readText()).optJSONArray("outbounds") ?: return null
      val proxyProtocols = setOf(
        "vless", "vmess", "trojan", "shadowsocks", "tuic", "hysteria2", "hysteria",
        "wireguard", "http", "socks", "shadowtls"
      )
      for (i in 0 until outbounds.length()) {
        val ob = outbounds.getJSONObject(i)
        val proto = ob.optString("protocol").ifBlank { ob.optString("type") }
        if (proto in proxyProtocols) {
          val tag = ob.optString("tag")
          if (tag.isNotBlank() && tag != "proxy" && tag != "auto" && tag != "direct" && tag != "block") {
            return tag
          }
          val ep = extractEndpointFromOutbound(ob)
          if (!ep.isNullOrBlank()) return ep
          if (tag.isNotBlank() && tag != "proxy") return tag
        }
      }
      null
    } catch (e: Exception) {
      Log.w(TAG, "extractProxyOutboundTag: ${e.message}")
      null
    }
  }

  /**
   * Read `address:port` from a vless/vmess/trojan/shadowsocks outbound's
   * settings block (vnext[] or servers[]) or top-level server / server_port.
   */
  private fun extractEndpointFromOutbound(ob: JSONObject): String? {
    val directServer = ob.optString("server")
    if (directServer.isNotBlank()) {
      val port = ob.optInt("server_port", 0)
      return if (port > 0) "$directServer:$port" else directServer
    }
    val settings = ob.optJSONObject("settings") ?: return null
    for (key in arrayOf("vnext", "servers")) {
      val arr = settings.optJSONArray(key) ?: continue
      if (arr.length() == 0) continue
      val first = arr.optJSONObject(0) ?: continue
      val address = first.optString("address")
      if (address.isBlank()) continue
      val port = first.optInt("port", 0)
      return if (port > 0) "$address:$port" else address
    }
    val address = settings.optString("address")
    if (address.isBlank()) return null
    val port = settings.optInt("port", 0)
    return if (port > 0) "$address:$port" else address
  }
}
