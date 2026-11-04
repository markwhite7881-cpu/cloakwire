package app.cloakwire.client.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.LinkProperties
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
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
    internal const val EXTRA_START_REQUEST = "startRequest"
    internal const val EXTRA_PROFILE_SOURCE = "profileSource"
    internal const val EXTRA_EXPECTED_RUN = "expectedRunId"
    internal const val EXTRA_PREFLIGHTED = "configPreflighted"
    internal const val EXTRA_PENDING_START_CANCELLED = "pendingStartCancelled"
    const val EXTRA_APPS = "apps"
    const val EXTRA_APPS_MODE = "appsMode"
    /** Friendly server label supplied by the JS side. The Quick Settings
     *  tile uses this as its label. */
    const val EXTRA_SERVER_NAME = "serverName"
    const val EXTRA_ENGINE = "engine"
    const val EXTRA_KILL_SWITCH = "kill_switch"
    const val EXTRA_BLOCK_IPV6 = "block_ipv6"
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
    internal const val KEY_RECOVERY_ENABLED = "recovery_enabled"

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
  private val sessionGeneration=SessionGeneration(this)
  private val startGeneration:Long get()=sessionGeneration.current()
  @Volatile private var preflightGeneration = 0L
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
  @Volatile private var killSwitchMode = "on_drop"
  @Volatile private var blockIpv6 = true
  @Volatile private var isBlackholeActive = false
  @Volatile private var blackholeThread: Thread? = null

  private val recovery=RecoveryCoordinator(false)
  private val recoveryProbe by lazy { RecoveryProbeClient(this) }
  @Volatile private var acceptedSnapshot:RecoverySnapshot?=null
  @Volatile private var activeProbeSocket:Socket?=null
  private var physicalCallback:ConnectivityManager.NetworkCallback?=null
  private var wakeReceiver:BroadcastReceiver?=null
  @Volatile private var reuseRecoveryTun=false
  @Volatile private var replacingRecoveryEngine=false
  private var recoveryTunLease:ParcelFileDescriptor?=null
  private val recoveryTick=Runnable { runRecoveryStep() }
  @Volatile private var pendingRecoveryPreparation=0L

  internal fun pauseRecoveryForStart(request:Long) {
    recovery.pausePreparation(request)
    cancelRecoveryResources()
  }
  internal fun resumeRecoveryAfterRejectedStart(request:Long) {
    if(recovery.resumePreparation(request,SystemClock.elapsedRealtime()))mainHandler.post {
      if(!recovery.enabled() && sessionActive) {
        if(acceptedSnapshot?.engine==ENGINE_XRAY && xrayEngine?.isActive==false)onEngineDied(startGeneration,-1)
        else if(acceptedSnapshot?.engine==ENGINE_SINGBOX && singBoxEngine?.isActive!=true)failSession("engine_unavailable")
      }else scheduleRecovery()
    }
  }
  internal fun releaseRecoveryPreparation() {
    if(recovery.releasePreparation(SystemClock.elapsedRealtime()))mainHandler.post{scheduleRecovery()}
  }
  private fun cancelRecoveryResources() {
    mainHandler.removeCallbacks(recoveryTick)
    activeProbeSocket?.let { runCatching{it.close()} };activeProbeSocket=null
    recoveryProbe.cancel()
  }

  /** Called before new user intent waits for preflight or the service lifecycle lock. */
  internal fun cancelRecoveryIntent() {
    recovery.cancel()
    cancelRecoveryResources()
  }

  internal fun setRecoveryEnabled(enabled:Boolean) {
    if(!recovery.setEnabled(enabled,SystemClock.elapsedRealtime()))return
    mainHandler.removeCallbacks(recoveryTick)
    activeProbeSocket?.let{runCatching{it.close()}};activeProbeSocket=null;recoveryProbe.cancel()
    if(enabled)mainHandler.post{scheduleRecovery()}
  }

  internal fun recoveryStatus():app.tauri.plugin.JSObject {
    val state=recovery.status()
    return app.tauri.plugin.JSObject().put("enabled",state.enabled).put("phase",state.phase)
      .put("attempts",state.attempts).put("issue",state.issue?:JSONObject.NULL)
      .put("run_id",state.runId?:JSONObject.NULL) as app.tauri.plugin.JSObject
  }

  /** libbox duplicates this FD; the original Android VPN descriptor never closes in recovery. */
  internal fun recoveryTunFd():Int? {
    if(!reuseRecoveryTun)return null
    val original=tunPfd?:error("recovery_tun_unavailable")
    return ParcelFileDescriptor.dup(original.fileDescriptor).also{recoveryTunLease=it}.fd
  }

  private fun observeRecoveryNetwork() {
    val cm=getSystemService(ConnectivityManager::class.java)
    fun changed() { mainHandler.post {
      if(active!==this)return@post
      val physical=ProbePlatform.choose(cm)
      val stamp=physical?.let{ProbePlatform.stamp(cm,it)}
      if(recovery.network(stamp,false,SystemClock.elapsedRealtime())) {
        recoveryProbe.cancel();activeProbeSocket?.let{runCatching{it.close()}};activeProbeSocket=null
      }
      scheduleRecovery()
    } }
    val callback=object:ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network:Network)=changed()
      override fun onLost(network:Network)=changed()
      override fun onCapabilitiesChanged(network:Network,caps:NetworkCapabilities) { if(!caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))changed() }
      override fun onLinkPropertiesChanged(network:Network,props:LinkProperties)=changed()
    }
    runCatching {
      cm.registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(),callback)
      physicalCallback=callback
    }
    val receiver=object:BroadcastReceiver() {
      override fun onReceive(context:Context,intent:Intent) {
        if(active!==this@CloakwireVpnService)return
        recovery.wake(SystemClock.elapsedRealtime());cancelRecoveryResources();changed()
      }
    }
    if(Build.VERSION.SDK_INT>=33)registerReceiver(receiver,IntentFilter(Intent.ACTION_SCREEN_ON),Context.RECEIVER_NOT_EXPORTED)
    else @Suppress("DEPRECATION") registerReceiver(receiver,IntentFilter(Intent.ACTION_SCREEN_ON))
    wakeReceiver=receiver
    changed()
  }

  private fun scheduleRecovery() {
    mainHandler.removeCallbacks(recoveryTick)
    if(active!==this || starting)return
    recovery.delay(SystemClock.elapsedRealtime())?.let{mainHandler.postDelayed(recoveryTick,it)}
  }

  private fun runRecoveryStep() {
    if(active!==this || starting)return
    val work=recovery.next(SystemClock.elapsedRealtime())
    if(work==null) {
      if(recovery.status().phase=="exhausted" && VpnEvents.state!=VpnEvents.STATE_ERROR)failSession("recovery_exhausted")
      return
    }
    thread(name="vpn-recovery",isDaemon=true) {
      when(work.decision) {
        RecoveryDecision.ProbeActive -> {
          val result=probeActive(work)
          recovery.completeActive(work,result.outcome,result.issue,SystemClock.elapsedRealtime(),result.effective)
        }
        RecoveryDecision.ProbeCandidate -> {
          val result=probeRecoveryCandidate(work)
          recovery.completeCandidate(work,result.outcome,result.issue,SystemClock.elapsedRealtime())
        }
        is RecoveryDecision.Reconnect -> {
          val success=runCatching{replaceRecoveryEngine(work)}.getOrDefault(false)
          val current=recovery.completeRestart(work,success,SystemClock.elapsedRealtime())
          if(!current)mainHandler.post {
            val live=if(work.snapshot.engine==ENGINE_XRAY)xrayEngine?.isActive==true else singBoxEngine?.isActive==true
            if(recovery.cancelledReplacementNeedsAttention(work,live) && acceptedSnapshot===work.snapshot && !starting && VpnEvents.state!=VpnEvents.STATE_ERROR)
              failSession("engine_unavailable")
          }
          if(current && success)mainHandler.post {
            if(acceptedSnapshot===work.snapshot && VpnEvents.currentRun()==work.snapshot.runId && sessionActive) {
              VpnEvents.update(VpnEvents.STATE_RUNNING)
            }
          }
        }
        else -> {}
      }
      mainHandler.post {
        if(recovery.status().phase=="exhausted" && acceptedSnapshot===work.snapshot && VpnEvents.state!=VpnEvents.STATE_ERROR)failSession("recovery_exhausted")
        scheduleRecovery()
      }
    }
  }

  private data class RecoveryPath(val outbound:String,val endpoint:RecoveryRuntimeConfig.Endpoint,val sing:SingBoxEngine?,val groups:SingBoxEngine.GroupWitness?)
  private fun ownsRecovery(work:RecoveryWork):Boolean=recovery.isCurrent(work) && acceptedSnapshot===work.snapshot && VpnEvents.currentRun()==work.snapshot.runId
  private fun captureRecoveryPath(work:RecoveryWork) = captureActivePath(work.snapshot) { ownsRecovery(work) }

  private fun captureActivePath(snapshot:RecoverySnapshot, owns:()->Boolean):RecoveryPath? {
    val wired=snapshot.runtime?:return null
    val sing=if(snapshot.engine==ENGINE_SINGBOX)singBoxEngine else null
    val groups=if(wired.dynamic)sing?.witness(owns)?:return null else null
    val effective=if(groups!=null)RecoveryRuntimeConfig.effective(snapshot.config,groups.selections)?:return null else wired.outbound
    val endpoint=wired.endpoints[effective]?:return null
    return RecoveryPath(effective,endpoint,sing,groups)
  }
  /** Internal Rust transport only. Credentials never cross the WebView boundary. */
  internal fun speedTestRoute(runId: String): app.tauri.plugin.JSObject? {
    val snapshot = acceptedSnapshot ?: return null
    fun owns() = active === this && sessionActive && !starting && !replacingRecoveryEngine &&
      acceptedSnapshot === snapshot && runId == snapshot.runId && VpnEvents.currentRun() == runId &&
      VpnEvents.state == VpnEvents.STATE_RUNNING && recovery.ownsAccepted(snapshot)
    if (!owns()) return null
    val path = captureActivePath(snapshot, ::owns) ?: return null
    val engine = if (snapshot.engine == ENGINE_XRAY) {
      xrayEngine?.takeIf { it.isActive }
    } else {
      path.sing?.takeIf { it === singBoxEngine && it.isActive &&
        (path.groups == null || it.witnessUnchanged(path.groups)) }
    } ?: return null
    if (!ProbeHttp.challenge(path.endpoint.port) || !owns()) return null
    return app.tauri.plugin.JSObject().apply {
      put("port", path.endpoint.port)
      put("password", path.endpoint.password)
      put("revision", listOf(snapshot.id, path.endpoint.tag, System.identityHashCode(engine), path.groups?.revision).joinToString("/"))
    }
  }

  private fun recoveryPathUnchanged(work:RecoveryWork,path:RecoveryPath):Boolean {
    if(!ownsRecovery(work))return false
    if(work.snapshot.engine==ENGINE_XRAY)return xrayEngine?.isActive==true
    val engine=path.sing?:return false
    if(singBoxEngine!==engine || !engine.isActive)return false
    val before=path.groups?:return true
    if(!engine.witnessUnchanged(before))return false
    val after=engine.witness{ownsRecovery(work)}?:return false
    return after.revision==before.revision && after.selections==before.selections && engine.witnessUnchanged(after) &&
      RecoveryRuntimeConfig.effective(work.snapshot.config,after.selections)==path.outbound
  }
  internal fun onEffectiveOutboundChanged(engine:SingBoxEngine) {
    if(replacingRecoveryEngine)return
    mainHandler.post {
      if(singBoxEngine!==engine || !sessionActive || starting || replacingRecoveryEngine || !recovery.enabled())return@post
      recovery.wake(SystemClock.elapsedRealtime());cancelRecoveryResources();scheduleRecovery()
    }
  }
  private fun probeRecoveryCandidate(work:RecoveryWork):RecoveryProbeClient.Result {
    val unavailable=RecoveryProbeClient.Result(HealthOutcome.UNAVAILABLE,HealthIssue.UNSUPPORTED_PROBE)
    val path=captureRecoveryPath(work)?:return unavailable
    if(work.effective!=path.outbound)return unavailable
    val config=runCatching{RecoveryRuntimeConfig.candidate(work.snapshot.config,work.snapshot.engine,path.outbound,path.groups?.selections?:emptyMap())}.getOrNull()?:return unavailable
    val result=recoveryProbe.probe(work.snapshot,work.network.orEmpty(),config,path.outbound){ownsRecovery(work)}
    if(!recoveryPathUnchanged(work,path))return unavailable
    return result
  }
  private fun probeActive(work:RecoveryWork):RecoveryProbeClient.Result {
    val deadline=SystemClock.elapsedRealtime()+ProbeState.DEADLINE_MS
    fun current():Boolean=ownsRecovery(work) && SystemClock.elapsedRealtime()<deadline
    if(!current())return RecoveryProbeClient.Result(HealthOutcome.CANCELLED,null)
    val live=if(work.snapshot.engine==ENGINE_XRAY)xrayEngine?.isActive==true else singBoxEngine?.isActive==true
    if(!live) {
      recovery.engineDied(recovery.epoch(),SystemClock.elapsedRealtime())
      return RecoveryProbeClient.Result(HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE)
    }
    val path=captureRecoveryPath(work)?:return RecoveryProbeClient.Result(HealthOutcome.UNAVAILABLE,HealthIssue.UNSUPPORTED_PROBE)
    val cm=getSystemService(ConnectivityManager::class.java)
    fun sameNetwork():Boolean=ProbePlatform.choose(cm)?.let{ProbePlatform.stamp(cm,it)}==work.network
    if(!sameNetwork())return RecoveryProbeClient.Result(HealthOutcome.UNAVAILABLE,HealthIssue.NETWORK_UNAVAILABLE)
    val timeout=Runnable{if(ownsRecovery(work))activeProbeSocket?.let{runCatching{it.close()}}}
    mainHandler.postDelayed(timeout,(deadline-SystemClock.elapsedRealtime()).coerceAtLeast(0))
    val success=try {
      runCatching {
        if(!ProbeHttp.challenge(path.endpoint.port))return@runCatching false
        var ok=false
        for(fallback in listOf(false,true)) {
          if(!current() || !sameNetwork())return@runCatching false
          ok=runCatching{ProbeHttp.request(path.endpoint.port,path.endpoint.password,fallback){socket->activeProbeSocket=socket;if(!current())socket?.close()}}.getOrDefault(false)
          if(ok)break
        }
        ok
      }.getOrDefault(false)
    }finally{mainHandler.removeCallbacks(timeout);activeProbeSocket=null}
    if(!current())return RecoveryProbeClient.Result(HealthOutcome.UNAVAILABLE,HealthIssue.TIMEOUT)
    if(!sameNetwork())return RecoveryProbeClient.Result(HealthOutcome.UNAVAILABLE,HealthIssue.NETWORK_UNAVAILABLE)
    val stillLive=if(work.snapshot.engine==ENGINE_XRAY)xrayEngine?.isActive==true else singBoxEngine?.isActive==true
    if(!stillLive) {
      recovery.engineDied(recovery.epoch(),SystemClock.elapsedRealtime())
      return RecoveryProbeClient.Result(HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE)
    }
    if(!recoveryPathUnchanged(work,path))return RecoveryProbeClient.Result(HealthOutcome.UNAVAILABLE,HealthIssue.UNSUPPORTED_PROBE)
    return RecoveryProbeClient.Result(if(success)HealthOutcome.HEALTHY else HealthOutcome.FAILED,if(success)null else HealthIssue.PROBE_TARGET_UNAVAILABLE,path.outbound)
  }

  /** Replacement preserves the same TUN, app policy, protection and accepted engine/config. */
  private fun replaceRecoveryEngine(work:RecoveryWork):Boolean = synchronized(this) {
    if(!recovery.isCurrent(work) || acceptedSnapshot!==work.snapshot || active!==this || tunPfd==null)return false
    replacingRecoveryEngine=true
    try {
    val snapshot=work.snapshot
    isBlackholeActive=false
    blackholeThread?.let{it.interrupt();it.join(750);check(!it.isAlive){"recovery_blackhole_busy"}}
    blackholeThread=null
    if(!recovery.isCurrent(work))return false
    val config=snapshot.runtime?.config?:snapshot.config
    if(snapshot.engine==ENGINE_XRAY) {
      // Only this session's process handle is retired; diagnostics own another lease.
      runCatching{tun2socks.stop()}
      xrayEngine?.closeBestEffort();xrayEngine=null
      if(!recovery.isCurrent(work))return false
      protectedProxy.start()
      val generation=startGeneration
      val engine=XrayEngine(this){code->onEngineDied(generation,code)}
      xrayEngine=engine
      engine.start(config){recovery.isCurrent(work)}
      if(!recovery.isCurrent(work)){engine.closeBestEffort();return false}
      check(tun2socks.start(tunPfd!!,SOCKS_INBOUND_PORT,TUN_MTU,TUN_ADDRESS)){"tun2socks failed to start"}
      sessionActive=true;startTrafficPoller()
    }else {
      singBoxEngine?.closeBestEffort();singBoxEngine=null
      if(!recovery.isCurrent(work))return false
      val generation=startGeneration
      val engine=SingBoxEngine(this){message->onSingBoxDied(generation,message)}
      singBoxEngine=engine;reuseRecoveryTun=true
      try { if(!recovery.isCurrent(work))return false;engine.start(config){recovery.isCurrent(work)} }
      finally { reuseRecoveryTun=false;recoveryTunLease?.close();recoveryTunLease=null }
      if(!recovery.isCurrent(work)){engine.closeBestEffort();return false}
      sessionActive=true
    }
    true
    }finally{replacingRecoveryEngine=false}
  }

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
    recovery.setEnabled(getSharedPreferences(PREFS,Context.MODE_PRIVATE).getBoolean(KEY_RECOVERY_ENABLED,false),SystemClock.elapsedRealtime())
    observeRecoveryNetwork()
    // Wake the Quick Settings tile and Home Screen widgets on every state transition
    VpnEvents.setStateChangeListener {
      QuickTileService.notifyStateChanged(this)
      app.cloakwire.client.widget.CloakwireWidgetUpdater.updateAllWidgets(this)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopVpn(cancelPendingStart = !intent.getBooleanExtra(EXTRA_PENDING_START_CANCELLED, false))
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
        val killSwitch = intent.getStringExtra(EXTRA_KILL_SWITCH) ?: "on_drop"
        val blockIpv6Val = intent.getBooleanExtra(EXTRA_BLOCK_IPV6, true)
        queueStart(
          configPath, apps, appsMode, serverName, engine, killSwitch, blockIpv6Val,
          preflighted = intent.getBooleanExtra(EXTRA_PREFLIGHTED, false),
          profileSource = intent.getStringExtra(EXTRA_PROFILE_SOURCE).orEmpty(),
          startRequest = if(intent.hasExtra(EXTRA_START_REQUEST)) intent.getLongExtra(EXTRA_START_REQUEST,-1L) else null,
          expectedRun = intent.getStringExtra(EXTRA_EXPECTED_RUN).orEmpty(),
        )
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
          queueStart(persisted.absolutePath, apps, appsMode, engine = engine)
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

  /** Saved quick-tile/widget/sticky configs are checked too, including pre-upgrade sessions. */
  private fun queueStart(
    configPath: String,
    apps: String,
    appsMode: String,
    serverName: String = "",
    engine: String = ENGINE_SINGBOX,
    killSwitch: String = "on_drop",
    blockIpv6Option: Boolean = true,
    preflighted: Boolean = false,
    profileSource: String = "",
    startRequest:Long?=null,
    expectedRun: String = "",
  ) {
    val selectedEngine = if (engine == ENGINE_SINGBOX) ENGINE_SINGBOX else ENGINE_XRAY
    val selectedApps = apps.ifBlank { "[]" }
    val selectedMode = if (appsMode == "include") "include" else "exclude"
    val source = File(configPath)
    val checkedSnapshot = preflighted && runCatching {
      source.canonicalFile.parentFile == cacheDir.canonicalFile && source.name.startsWith("vpn-checked-")
    }.getOrDefault(false)
    // A delayed service intent cannot steal a newer manual preparation's pause/generation.
    if(!VpnEvents.matchesRun(expectedRun) || (startRequest!=null && !AndroidProfilePreflight.starts.isCurrent(startRequest))) {
      if(checkedSnapshot)source.delete()
      return
    }
    val request=++preflightGeneration
    val recoveryRequest=startRequest?:-request
    pendingRecoveryPreparation=recoveryRequest
    pauseRecoveryForStart(recoveryRequest)
    // Android requires a foreground notification promptly; an existing session
    // keeps its notification/state while the candidate is being checked.
    if (!sessionActive && !starting) startForegroundWith("Checking profile…")
    thread(name = "vpn-profile-preflight") {
      try {
        ProfilePreflight.run(
          prepare = {
            val raw = source.readText()
            if (checkedSnapshot) raw else AndroidProfilePreflight.prepare(
              this, raw, selectedEngine, selectedApps, selectedMode,
            )
          },
          check = { config ->
            if (!checkedSnapshot) AndroidProfilePreflight.check(this, config, selectedEngine)
          },
          handoff = { config ->
            val preparedRuntime=runCatching {
              val port=ServerSocket(0,1,InetAddress.getByName("127.0.0.1")).use{it.localPort}
              RecoveryRuntimeConfig.wire(config,selectedEngine,port,UUID.randomUUID().toString()){
                ServerSocket(0,1,InetAddress.getByName("127.0.0.1")).use{it.localPort}
              }?.also {
                AndroidProfilePreflight.check(this,it.config,selectedEngine)
              }
            }.getOrNull()
            mainHandler.post {
              if (request != preflightGeneration) return@post
              try {
                if(!VpnEvents.matchesRun(expectedRun)){resumeRecoveryAfterRejectedStart(recoveryRequest);return@post}
                val owner=if(checkedSnapshot) ProfileSource.parse(profileSource) else null
                val accept={acceptStart(config, selectedApps, selectedMode, serverName, selectedEngine, killSwitch, blockIpv6Option,owner,preparedRuntime,recoveryRequest)}
                if(startRequest!=null)AndroidProfilePreflight.starts.handoff(startRequest,accept) else accept()
              } catch (error: Exception) {
                reportPreflightFailure(request, error)
              }
            }
          },
        )
      } catch (error: Exception) {
        reportPreflightFailure(request, error)
      } catch (error: LinkageError) {
        reportPreflightFailure(request, error)
      } finally {
        if (checkedSnapshot) source.delete()
      }
    }
  }

  private fun reportPreflightFailure(request: Long, error: Throwable) {
    val safe = ProfilePreflight.failure(error).message ?: ProfileCheckKind.FAILED.token
    mainHandler.post {
      if(request!=preflightGeneration)return@post
      resumeRecoveryAfterRejectedStart(pendingRecoveryPreparation)
      if(sessionActive || starting)return@post
      VpnEvents.update(VpnEvents.STATE_ERROR, safe)
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun acceptStart(
    config:String,apps:String,appsMode:String,serverName:String="",engine:String=ENGINE_XRAY,
    killSwitch:String="on_drop",blockIpv6Option:Boolean=true,profileSource:ProfileSource?=null,
    runtime:RecoveryRuntimeConfig.Wired?=null,preparationRequest:Long,
  ) {
    val selectedEngine=if(engine==ENGINE_SINGBOX)ENGINE_SINGBOX else ENGINE_XRAY
    val selectedApps=apps.ifBlank{"[]"}
    val selectedAppsMode=if(appsMode=="include")"include" else "exclude"
    val prefs=getSharedPreferences(PREFS,Context.MODE_PRIVATE)
    val resolvedName=serverName.ifBlank{prefs.getString(KEY_LAST_SERVER,"").orEmpty().ifBlank{extractProxyOutboundTag(config).orEmpty()}}
    val runId=UUID.randomUUID().toString()
    val snapshot=RecoverySnapshot(UUID.randomUUID().toString(),config,selectedApps,selectedAppsMode,selectedEngine,killSwitch,blockIpv6Option,resolvedName,profileSource,runId,runtime)
    val store=RecoveryConfigStore(configFile(this),{file,value->
      java.io.FileOutputStream(file).use{out->out.write(value.toByteArray(Charsets.UTF_8));out.fd.sync()}
    }){from,to->Os.rename(from.absolutePath,to.absolutePath)}
    // Stage/fsync outside lifecycle locks. The final atomic rename and accepted owner change
    // share service -> coordinator lock order, so Stop/new preparation cannot publish a stale file.
    val staged=store.stage(config)
    try {
    synchronized(this) {
    var currentGen=0L
    if(!recovery.acceptPreparation(preparationRequest,snapshot,SystemClock.elapsedRealtime()){
      staged.publish()
      currentGen=sessionGeneration.begin()
    })throw ProfileCheckException(ProfileCheckKind.CANCELLED)
    cancelRecoveryResources()
    acceptedSnapshot=snapshot
    killSwitchMode=killSwitch;blockIpv6=blockIpv6Option
    isBlackholeActive=false;blackholeThread?.interrupt();blackholeThread=null
    VpnEvents.setEngine(selectedEngine)
    prefs.edit().putBoolean(KEY_IS_CONNECTED,true).putString(KEY_LAST_ENGINE,selectedEngine)
      .putString(KEY_LAST_APPS,selectedApps).putString(KEY_LAST_APPS_MODE,selectedAppsMode)
      .putString(KEY_LAST_SERVER,resolvedName).apply()
    activeServerName=resolvedName
    startForegroundWith("Connecting…")
    VpnEvents.acceptSource(profileSource,resolvedName,runId)
    VpnEvents.update(VpnEvents.STATE_STARTING)
    if(starting || sessionActive)runCatching{teardownComponents()}
    starting=true
    thread(name="vpn-start") {
      synchronized(this@CloakwireVpnService) {
        var startSnapshot=snapshot
        try {
          if(!ownsStart(currentGen,startSnapshot))return@thread
          try {
            runVpn(runtime?.config?:config,selectedApps,selectedAppsMode,selectedEngine,currentGen,startSnapshot)
          }catch(error:Exception) {
            if(runtime==null || !ownsStart(currentGen,startSnapshot))throw error
            teardownComponents()
            if(!ownsStart(currentGen,startSnapshot))throw error
            val fallback=snapshot.copy(runtime=null)
            if(!recovery.replaceAccepted(startSnapshot,fallback){acceptedSnapshot=fallback})throw error
            startSnapshot=fallback
            runVpn(config,selectedApps,selectedAppsMode,selectedEngine,currentGen,startSnapshot)
          }
          if(!ownsStart(currentGen,startSnapshot)){teardownComponents();return@thread}
          VpnEvents.update(VpnEvents.STATE_RUNNING)
          startForegroundWith("Connected")
        }catch(error:Exception) {
          if(!ownsStart(currentGen,startSnapshot)){teardownComponents();return@thread}
          cancelRecoveryIntent()
          Log.e(TAG,"VPN start failed",error)
          VpnEvents.update(VpnEvents.STATE_ERROR,error.message?:error.toString())
          runCatching{teardownComponents()}
          stopForeground(STOP_FOREGROUND_REMOVE);stopSelf()
        }finally {
          if(startGeneration==currentGen){starting=false;mainHandler.post{scheduleRecovery()}}
        }
      }
    }
    }
    }finally{staged.close()}
  }

  private fun ownsStart(generation:Long,snapshot:RecoverySnapshot):Boolean = startGeneration==generation && starting && recovery.ownsAccepted(snapshot)

  private fun runVpn(config: String, apps: String, appsMode: String, engine: String, currentGen: Long, snapshot:RecoverySnapshot) {
    if (engine == ENGINE_SINGBOX) {
      runSingBoxVpn(config, currentGen,snapshot)
      return
    }
    runXrayVpn(config, apps, appsMode, currentGen,snapshot)
  }

  private fun runXrayVpn(config: String, apps: String, appsMode: String, currentGen: Long,snapshot:RecoverySnapshot) {
    resetLogFile(logFile(this))
    logOutboundTopology(config)

    if (!ownsStart(currentGen,snapshot)) return

    // 2. TUN — the service owns the descriptor for the whole session.
    val pfd = establishTun(apps, appsMode)
    tunPfd = pfd

    if (!ownsStart(currentGen,snapshot)) {
      runCatching { pfd.close() }
      tunPfd = null
      return
    }

    // 3. Protected dialer. Started only after the TUN exists so
    //    protect() operates on a live VPN session.
    protectedProxy.start()

    if (!ownsStart(currentGen,snapshot)) {
      runCatching { protectedProxy.stop() }
      return
    }

    // 4. xray sidecar (readiness-checked; throws with the sanitized
    //    tail of the engine log if the config is rejected).
    val engine = XrayEngine(this) { code -> onEngineDied(currentGen,code) }
    engine.start(config){ownsStart(currentGen,snapshot)}
    xrayEngine = engine

    if (!ownsStart(currentGen,snapshot)) {
      runCatching { engine.closeBestEffort() }
      xrayEngine = null
      return
    }

    // 5. hev-socks5-tunnel: TUN fd → xray socks inbound. Uses the
    //    live descriptor (NOT detached); we close it after stopping
    //    the tunnel.
    val wired = tun2socks.start(pfd, SOCKS_INBOUND_PORT, TUN_MTU, TUN_ADDRESS)
    if (!wired) {
      throw IllegalStateException("tun2socks failed to start")
    }
    if (!ownsStart(currentGen,snapshot)) {
      runCatching { tun2socks.stop() }
      return
    }
    sessionActive = true
    engineRestarts = 0
    startTrafficPoller()
  }

  /** Start the in-process libbox engine. CloakwirePlatform owns TUN setup. */
  private fun runSingBoxVpn(config: String, currentGen: Long,snapshot:RecoverySnapshot) {
    resetLogFile(singboxLogFile(this))

    if (!ownsStart(currentGen,snapshot)) return

    val engine = SingBoxEngine(this) { message -> onSingBoxDied(currentGen,message) }
    singBoxEngine = engine
    engine.start(config){ownsStart(currentGen,snapshot)}
    if (!ownsStart(currentGen,snapshot)) {
      runCatching { engine.closeBestEffort() }
      singBoxEngine = null
      return
    }
    check(tunPfd != null) { "sing-box did not establish a TUN interface" }
    sessionActive = true
    engineRestarts = 0
  }

  /** Runtime log rotation happens only after the candidate passed preflight. */
  private fun resetLogFile(file: File) {
    file.parentFile?.mkdirs()
    if (file.exists()) file.delete()
  }

  private fun onSingBoxDied(generation:Long,message: String) {
    mainHandler.post { sessionGeneration.runIfCurrent(generation) {
      if(!sessionActive)return@runIfCurrent
      if(recovery.enabled()) {
        if(singBoxEngine?.isActive!=true)recovery.engineDied(recovery.epoch(),SystemClock.elapsedRealtime())
        else recovery.wake(SystemClock.elapsedRealtime())
        scheduleRecovery()
      }else failSession(message)
    } }
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
      .setBlocking(true)
      .setConfigureIntent(mainActivityPendingIntent())

    try {
      builder.addAddress("fd00::1", 128)
    } catch (e: Exception) {
      Log.w(TAG, "IPv6 address setup: ${e.message}")
    }

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

  /**
   * The xray process died unexpectedly. Restart it (bounded); when the
   * budget is exhausted, error the session out — a dead engine with a
   * live TUN would black-hole all captured traffic.
   */
  private fun onEngineDied(generation:Long,exitCode: Int) {
    mainHandler.post {
      sessionGeneration.runIfCurrent(generation) {
        if (!sessionActive) return@runIfCurrent
        val engine=xrayEngine
        if(recovery.enabled()) {
          if(xrayEngine?.isActive!=true)recovery.engineDied(recovery.epoch(),SystemClock.elapsedRealtime())
          scheduleRecovery();return@runIfCurrent
        }
        val snapshot=acceptedSnapshot
        val config=snapshot?.runtime?.config?:snapshot?.config
        if(engine==null || snapshot==null || config.isNullOrEmpty() || engineRestarts>=MAX_ENGINE_RESTARTS) {
          failSession("engine exited (code=$exitCode)")
          return@runIfCurrent
        }
        engineRestarts++
        VpnEvents.update(VpnEvents.STATE_STARTING,"reconnecting")
        thread(name="vpn-engine-restart") {
          Thread.sleep(ENGINE_RESTART_DELAY_MS)
          if(startGeneration!=generation || !sessionActive || xrayEngine!==engine || !recovery.legacyAllowed(snapshot))return@thread
          val error=runCatching { engine.start(config){startGeneration==generation && sessionActive && xrayEngine===engine && recovery.legacyAllowed(snapshot)} }.exceptionOrNull()
          mainHandler.post {
            sessionGeneration.runIfCurrent(generation) {
              if(sessionActive && xrayEngine===engine) {
                if(error==null)VpnEvents.update(VpnEvents.STATE_RUNNING)
                else failSession(error.message?:"engine restart failed")
              }
            }
          }
        }
      }
    }
  }

  private fun failSession(message: String) {
    Log.e(TAG, "Session failed: $message (killSwitch=$killSwitchMode)")
    if (killSwitchMode != "off" && tunPfd != null) {
      isBlackholeActive = true
      VpnEvents.update(VpnEvents.STATE_ERROR, "Kill Switch: $message")
      updateNotification("Kill Switch: traffic blocked")
      runCatching { tun2socks.stop() }
      xrayEngine?.let { runCatching { it.closeBestEffort() } }
      xrayEngine = null
      singBoxEngine?.let { runCatching { it.closeBestEffort() } }
      singBoxEngine = null
      runCatching { protectedProxy.stop() }
      startBlackholeDrain()
    } else {
      VpnEvents.update(VpnEvents.STATE_ERROR, message)
      getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        .edit()
        .putBoolean(KEY_IS_CONNECTED, false)
        .apply()
      runCatching { teardownComponents() }
      stopForeground(true)
      stopSelf()
    }
  }

  private fun startBlackholeDrain() {
    val pfd = tunPfd ?: return
    blackholeThread?.interrupt()
    blackholeThread = thread(name = "vpn-blackhole-drain", isDaemon = true) {
      try {
        val poll=StructPollfd().apply{fd=pfd.fileDescriptor;events=OsConstants.POLLIN.toShort()}
        val buf=ByteArray(32768)
        while(isBlackholeActive && !Thread.currentThread().isInterrupted) {
          // Borrow the service-owned fd; no FileInputStream finalizer may close the TUN.
          if(Os.poll(arrayOf(poll),250)<=0)continue
          if(!isBlackholeActive || Thread.currentThread().isInterrupted)break
          if((poll.revents.toInt() and OsConstants.POLLIN)==0)break
          if(Os.read(pfd.fileDescriptor,buf,0,buf.size)<=0)break
        }
      } catch (_: Exception) {}
    }
  }

  fun stopVpn(cancelPendingStart: Boolean = true) {
    cancelRecoveryIntent()
    synchronized(this) {
    ProbeCoordinator.invalidate()
    if (cancelPendingStart) AndroidProfilePreflight.starts.cancel()
    preflightGeneration++
    sessionGeneration.begin()
    starting = false
    isBlackholeActive = false
    blackholeThread?.interrupt()
    blackholeThread = null
    sessionActive = false
    activeServerName = ""
    acceptedSnapshot=null
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
  }

  /**
   * Tear the session down in reverse start order. Synchronized so a
   * restart-of-session and a stop never interleave.
   */
  @Synchronized
  private fun teardownComponents() {
    isBlackholeActive = false
    blackholeThread?.interrupt()
    blackholeThread = null
    sessionActive = false
    stopTrafficPoller()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
      runCatching { setUnderlyingNetworks(null) }
    }
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
    cancelRecoveryIntent()
    physicalCallback?.let{runCatching{getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)}};physicalCallback=null
    wakeReceiver?.let{runCatching{unregisterReceiver(it)}};wakeReceiver=null
    acceptedSnapshot=null
    ProbeCoordinator.invalidate()
    // The system can kill the service without ACTION_STOP (revoke,
    // always-on change, task removal) — make sure everything goes down.
    preflightGeneration++
    sessionGeneration.begin()
    starting = false
    teardownComponents()
    active = null
    activeServerName = ""
    VpnEvents.setStateChangeListener(null)
    if (VpnEvents.state != VpnEvents.STATE_STOPPED && VpnEvents.state != VpnEvents.STATE_ERROR) {
      VpnEvents.update(VpnEvents.STATE_STOPPED)
    }
    QuickTileService.notifyStateChanged(this)
    app.cloakwire.client.widget.CloakwireWidgetUpdater.updateAllWidgets(this)
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    Log.i(TAG, "onTaskRemoved: app task cleared from recents; stopping VPN service")
    stopVpn()
    super.onTaskRemoved(rootIntent)
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

  private fun updateNotification(text: String) {
    val notification = buildNotification(text)
    val manager = getSystemService(NotificationManager::class.java)
    manager?.notify(NOTIFICATION_ID, notification)
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
    val title = if (isBlackholeActive) {
      "Cloakwire • Kill Switch"
    } else if (text == "Connected") {
      if (activeServerName.isNotBlank()) "Cloakwire • $activeServerName" else "Cloakwire • Connected"
    } else {
      "Cloakwire"
    }
    val contentText = if (isBlackholeActive) {
      "Connection dropped. Kill Switch is blocking traffic."
    } else if (text == "Connected") {
      val engineLabel = if (VpnEvents.activeEngine == ENGINE_XRAY || VpnEvents.activeEngine == "xray") "Xray Core" else "sing-box"
      "Protected via $engineLabel"
    } else {
      text
    }
    val actionLabel = if (isBlackholeActive) "Unblock" else "Disconnect"
    return builder
      .setContentTitle(title)
      .setContentText(contentText)
      .setSmallIcon(R.drawable.ic_vpn_key)
      .setContentIntent(mainActivityPendingIntent())
      .setOngoing(true)
      .addAction(
        Notification.Action.Builder(null, actionLabel, stopIntent).build()
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
  private fun extractProxyOutboundTag(config: String): String? {
    return try {
      val outbounds = JSONObject(config).optJSONArray("outbounds") ?: return null
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
