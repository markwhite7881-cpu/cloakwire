package app.cloakwire.client.vpn

import app.tauri.plugin.JSObject

/**
 * Bridge between [CloakwireVpnService] (owns the real VPN state; runs
 * for as long as the process lives) and [VpnPlugin] (owns the webview
 * channel; recreated with every Activity). The service writes state
 * here, the plugin polls it via `status` and receives pushes via the
 * "status" plugin event.
 */
object VpnEvents {
  const val STATE_STOPPED = "stopped"
  const val STATE_STARTING = "starting"
  const val STATE_RUNNING = "running"
  const val STATE_ERROR = "error"

  @Volatile var state: String = STATE_STOPPED
    private set
  @Volatile var message: String = ""
    private set
  @Volatile var since: Long = 0L
    private set
  /**
   * Active engine name, e.g. `"sing-box"` or `"xray"`. The service
   * sets this when it accepts an `ACTION_START`; the plugin exposes
   * it through [statusJson] so the frontend can drive its engine
   * badges and blocked "test proxy" controls.
   */
  @Volatile var activeEngine: String = ""
    private set

  @Volatile private var acceptedSource: ProfileSource? = null
  @Volatile private var runId: String? = null
  @Volatile private var profileName: String? = null
  @Volatile private var checkEvidence: ProfileCheckEvidence? = null
  @Synchronized internal fun recordCheck(source:ProfileSource?,outcome:String,error:String?=null,context:String=currentRun()) {
    checkEvidence=source?.let { ProfileCheckEvidence(it,outcome,System.currentTimeMillis(),error,context) }
    emit()
  }
  @Synchronized internal fun acceptSource(source:ProfileSource?,name:String,acceptedRun:String=java.util.UUID.randomUUID().toString()) {
    ProbeCoordinator.invalidate()
    acceptedSource=source;profileName=name;runId=acceptedRun
  }
  @Synchronized internal fun currentRun():String=runId?:"stopped"
  @Synchronized internal fun matchesRun(expected:String):Boolean = expected.isEmpty() || expected==(runId?:"stopped")

  /** Set by VpnPlugin.load / cleared by onDestroy. */
  @Volatile var emitter: ((String, JSObject) -> Unit)? = null

  /**
   * State-change observer, set by [CloakwireVpnService] on create /
   * cleared on destroy. The Quick Settings tile registers itself via
   * this hook so it gets a [TileService.requestListeningState] ping
   * on every state transition without the service having to remember
   * to notify at every call site.
   */
  @Volatile private var stateChangeListener: (() -> Unit)? = null

  fun setStateChangeListener(listener: (() -> Unit)?) {
    stateChangeListener = listener
  }

  @Synchronized
  fun update(newState: String, newMessage: String = "") {
    if(newState==STATE_STOPPED){acceptedSource=null;runId=null;profileName=null;if(checkEvidence?.outcome=="checking")checkEvidence=null}
    state = newState
    message = newMessage
    since = System.currentTimeMillis()
    emit()
    stateChangeListener?.invoke()
  }

  @Synchronized
  fun setEngine(engine: String) {
    activeEngine = engine
  }

  /**
   * 1 Hz traffic sample pushed by the VpnService from the
   * tun2socks byte counters. Same shape as the desktop Rust
   * `traffic` event, so the shared hook can consume either.
   */
  fun emitTraffic(upBps: Long, downBps: Long, upTotal: Long, downTotal: Long) {
    val obj = JSObject()
    obj.put("up_bps", upBps)
    obj.put("down_bps", downBps)
    obj.put("up_total", upTotal)
    obj.put("down_total", downTotal)
    obj.put("ts_ms", System.currentTimeMillis())
    try {
      emitter?.invoke("traffic", obj)
    } catch (_: Exception) {
      // Webview may be gone — polling continues.
    }
  }

  @Synchronized fun statusJson(): JSObject {
    val obj = JSObject()
    obj.put("state", state)
    obj.put("message", message)
    obj.put("since", since)
    obj.put("engine", activeEngine)
    obj.put("source", acceptedSource?.toJson()?:org.json.JSONObject.NULL)
    obj.put("run_id", runId?:org.json.JSONObject.NULL)
    obj.put("profile_name", profileName?:org.json.JSONObject.NULL)
    obj.put("profile_check", checkEvidence?.toJson()?:org.json.JSONObject.NULL)
    return obj
  }

  private fun emit() {
    try {
      emitter?.invoke("status", statusJson())
    } catch (_: Exception) {
      // Webview may be gone (activity destroyed) — the next `status`
      // command returns the persisted state anyway.
    }
  }
}
