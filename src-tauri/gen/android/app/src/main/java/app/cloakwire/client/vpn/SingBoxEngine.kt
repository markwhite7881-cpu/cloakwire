package app.cloakwire.client.vpn

import android.content.Context
import android.util.Log
import io.nekohasekai.libbox.CommandClient
import io.nekohasekai.libbox.CommandClientHandler
import io.nekohasekai.libbox.CommandClientOptions
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.ConnectionEvents
import io.nekohasekai.libbox.DnsQuery
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LogIterator
import io.nekohasekai.libbox.OutboundGroupItemIterator
import io.nekohasekai.libbox.OutboundGroupIterator
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.SetupOptions
import io.nekohasekai.libbox.StatusMessage
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.SystemProxyStatus
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** In-process sing-box engine backed by the bundled libbox AAR. */
class SingBoxEngine(
  private val service: CloakwireVpnService,
  private val onDied: (message: String) -> Unit,
) {
  companion object {
    private const val TAG = "SingBoxEngine"
    @Volatile private var libboxReady = false

    @Synchronized
    private fun setupOnce(context: Context) {
      if (libboxReady) return
      val options = SetupOptions().apply {
        basePath = context.filesDir.absolutePath
        workingPath = File(context.filesDir, "singbox").apply { mkdirs() }.absolutePath
        tempPath = context.cacheDir.absolutePath
        fixAndroidStack = true
        logMaxLines = 300L
        debug = false
      }
      Libbox.setup(options)
      libboxReady = true
    }

    internal fun checkConfig(context: Context, config: String) {
      setupOnce(context)
      Libbox.checkConfig(config)
    }

    fun version(context: Context): String = try {
      setupOnce(context)
      Libbox.version()
    } catch (e: Exception) {
      Log.w(TAG, "version probe failed", e)
      "sing-box"
    }
  }

  private val closing = AtomicBoolean(false)
  @Volatile private var server: CommandServer? = null
  @Volatile private var client: CommandClient? = null

  val isActive: Boolean
    @Synchronized get() = server?.ready() == true

  private var platform: CloakwirePlatform? = null
  internal data class GroupWitness(val selections:Map<String,String>,val revision:Long)
  private val groupState=RecoveryGroupState()
  private val witnessReader=BoundedNativeProfileCheck()
  private fun selections(groups:OutboundGroupIterator?):Map<String,String> {
    val result=linkedMapOf<String,String>()
    if(groups!=null)while(groups.hasNext()) {
      val group=groups.next()
      result[group.tag]=group.selected
    }
    return result
  }
  internal fun witness(isCurrent:()->Boolean):GroupWitness? {
    val owned=server?:return null
    if(closing.get() || !isCurrent())return null
    val revision=groupState.revision()
    var fresh:Map<String,String>?=null
    try {
      witnessReader.check(2000) {
        check(!closing.get() && server===owned && isCurrent())
        val control=Libbox.newStandaloneCommandClient()
        try { fresh=selections(control.groups) }
        finally {runCatching{control.disconnect()}}
        check(!closing.get() && server===owned && isCurrent())
      }
    }catch(_:Exception){return null}
    if(closing.get() || server!==owned || !isCurrent() || groupState.revision()!=revision)return null
    return fresh?.let{GroupWitness(it,revision)}
  }
  internal fun witnessUnchanged(witness:GroupWitness):Boolean = !closing.get() && groupState.revision()==witness.revision


  /** Start libbox with a complete sing-box configuration. */
  @Synchronized
  fun start(config: String,allowed:()->Boolean={true}) {
    check(allowed()){ "core_start_cancelled" }
    closeBestEffortLocked()
    setupOnce(service)
    closing.set(false)

    val plat = CloakwirePlatform(service)
    platform = plat
    val next = Libbox.newCommandServer(Handler(), plat)
    server = next
    try {
      next.start()
      val overrides = OverrideOptions().apply {
        // Android routing is owned by VpnService.Builder via
        // CloakwirePlatform.openTun(), not by desktop auto-redirect.
        autoRedirect = false
      }
      check(allowed()){ "core_start_cancelled" }
      next.startOrReloadService(config, overrides)
      check(allowed()){ "core_start_cancelled" }
      check(next.ready()) { "sing-box did not become ready" }

      // Connect CommandClient for real-time status and traffic monitoring
      try {
        val clientOpts = CommandClientOptions().apply {
          addCommand(Libbox.CommandStatus)
          addCommand(Libbox.CommandGroup)
          statusInterval = 1_000_000_000L
        }
        val commandClient = Libbox.newCommandClient(ClientHandler(), clientOpts)
        commandClient.connect()
        client = commandClient
      } catch (ce: Exception) {
        Log.w(TAG, "failed to start CommandClient for traffic stats", ce)
      }
    } catch (e: Exception) {
      closing.set(true)
      runCatching { next.closeService() }
      runCatching { next.close() }
      server = null
      plat.cleanup()
      platform = null
      throw e
    }
  }

  @Synchronized
  fun closeBestEffort() {
    closing.set(true)
    closeBestEffortLocked()
  }

  private fun closeBestEffortLocked() {
    val currentClient = client
    client = null
    if (currentClient != null) {
      runCatching { currentClient.disconnect() }
    }
    val current = server
    server = null
    if (current != null) {
      runCatching { current.closeService() }
      runCatching { current.close() }
    }
    platform?.cleanup()
    platform = null
  }

  private inner class ClientHandler : CommandClientHandler {
    override fun clearLogs() {}
    override fun connected() {
      Log.i(TAG, "CommandClient connected for traffic monitoring")
    }
    override fun disconnected(message: String?) {
      Log.i(TAG, "CommandClient disconnected: $message")
    }
    override fun initializeClashMode(modes: StringIterator?, current: String?) {}
    override fun setDefaultLogLevel(level: Int) {}
    override fun updateClashMode(newMode: String?) {}
    override fun writeConnectionEvents(events: ConnectionEvents?) {}
    override fun writeDNSQuery(query: DnsQuery?) {}
    override fun writeGroups(groups: OutboundGroupIterator?) {
      if(closing.get())return
      val next=selections(groups)
      if(groupState.update(next))service.onEffectiveOutboundChanged(this@SingBoxEngine)
    }
    override fun writeLogs(logs: LogIterator?) {}
    override fun writeOutbounds(outbounds: OutboundGroupItemIterator?) {}
    override fun writeStatus(message: StatusMessage?) {
      if (message != null && !closing.get()) {
        val up = message.uplink
        val down = message.downlink
        val upTotal = message.uplinkTotal
        val downTotal = message.downlinkTotal
        VpnEvents.emitTraffic(up, down, upTotal, downTotal)
      }
    }
  }

  private inner class Handler : CommandServerHandler {
    override fun serviceStop() {
      if (!closing.get()) {
        onDied("sing-box stopped unexpectedly")
      }
    }

    override fun serviceReload() {}

    override fun getSystemProxyStatus(): SystemProxyStatus =
      SystemProxyStatus().apply {
        available = false
        enabled = false
      }

    override fun setSystemProxyEnabled(enabled: Boolean) {}

    override fun triggerNativeCrash() {
      throw Exception("native crash trigger is disabled")
    }

    override fun writeDebugMessage(message: String) {
      Log.d(TAG, "core: $message")
    }

    override fun connectSSHAgent(): Int = -1
  }
}
