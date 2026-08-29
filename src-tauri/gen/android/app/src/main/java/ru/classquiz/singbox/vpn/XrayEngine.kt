package ru.classquiz.singbox.vpn

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * xray sidecar engine, v2 (2026-08-21 rebuild).
 *
 * Spawns the standalone ARM64 xray binary (staged as `libxray.so` in
 * jniLibs) with a complete JSON config produced upstream by Rust
 * (bundles normalized, share-links converted). The engine has NO TUN
 * responsibility: xray listens on loopback SOCKS only, and the TUN
 * side is handled by hev-socks5-tunnel + the VpnService.
 *
 * Key differences from v1 (which never worked):
 *  - no `XRAY_TUN_FD` environment fiction — stock Xray-core has no
 *    such channel and no `tun` inbound; the config must not contain
 *    either;
 *  - `XRAY_LOCATION_ASSET` points xray at nativeLibraryDir so geoip.dat /
 *    geosite.dat resolve regardless of the working directory;
 *  - readiness check: a config-rejected process dies within a second;
 *    start() waits and surfaces the sanitized log tail instead of
 *    returning success while the engine is already dead;
 *  - unexpected mid-session death is reported to [onDied] so the
 *    service can run its bounded restart policy.
 *
 * Threading: [start] and [closeBestEffort] are synchronized on the
 * engine instance; the drain/watch threads are daemons.
 */
class XrayEngine(
  private val context: Context,
  private val onDied: (exitCode: Int) -> Unit,
) {

  companion object {
    private const val TAG = "XrayEngine"
    const val BINARY_NAME = "libxray.so"
    private const val CONFIG_FILE_NAME = "xray-session.json"
    private const val ENV_ASSET_DIR = "XRAY_LOCATION_ASSET"
    /** How long a freshly spawned process gets to prove it stays up. */
    private const val READINESS_PROBE_MS = 1_500L

    @Volatile private var cachedVersion: String? = null
    @Volatile private var nativePathCache: String? = null

    /**
     * One-time `xray version` probe (own short-lived process), cached
     * for the app lifetime. Falls back to "xray" when the probe fails.
     */
    fun version(context: Context): String {
      cachedVersion?.let { return it }
      return try {
        val binary = resolveBinary(context)
        val proc = ProcessBuilder(binary, "version")
          .redirectErrorStream(true)
          .start()
        val output = proc.inputStream.bufferedReader().readText()
        proc.waitFor()
        // Output line looks like "Xray 26.7.28 (Xray, Penetrates All.) ...".
        val match = Regex("^Xray\\s+([0-9][^\\s]*)").find(output)
        val v = match?.groupValues?.get(1) ?: "xray"
        cachedVersion = v
        v
      } catch (e: Exception) {
        Log.w(TAG, "version probe failed: ${e.message}")
        "xray"
      }
    }

    private fun resolveBinary(context: Context): String {
      nativePathCache?.let { return it }
      val nativeDir = context.applicationInfo.nativeLibraryDir
      val path = File(nativeDir, BINARY_NAME)
      check(path.exists()) { "xray binary not found (staging skipped?)" }
      check(path.canExecute()) { "xray binary not executable (noexec mount?)" }
      nativePathCache = path.absolutePath
      return path.absolutePath
    }
  }

  @Volatile private var process: Process? = null
  private val closing = AtomicBoolean(false)

  val isActive: Boolean
    @Synchronized get() = process?.isAlive == true

  /**
   * Start a new xray session. Throws on binary-resolution failure,
   * spawn failure, or when the process dies during the readiness
   * probe (e.g. the config was rejected) — with the sanitized tail of
   * the engine log as the message.
   */
  @Synchronized
  fun start(config: String) {
    closeBestEffortLocked()

    val binary = resolveBinary(context)
    val configFile = File(context.filesDir, CONFIG_FILE_NAME)
    configFile.writeText(config)

    val pb = ProcessBuilder(binary, "run", "-c", configFile.absolutePath)
    pb.environment()[ENV_ASSET_DIR] = ensureGeodataDir(context)
    pb.redirectErrorStream(true)

    val proc = try {
      pb.start()
    } catch (e: Exception) {
      configFile.delete()
      throw e
    }
    process = proc
    closing.set(false)

    val drain = Thread({ drainAndRedact(proc) }, "vpn-xray-drain").apply {
      isDaemon = true
      start()
    }

    // Readiness probe: a rejected config exits within ~1s. If the
    // process is still alive after the probe window we call it up.
    Thread.sleep(READINESS_PROBE_MS)
    if (!proc.isAlive) {
      val code = proc.exitValue()
      drain.join(300)
      configFile.delete()
      process = null
      throw IllegalStateException(
        "xray rejected the config (exit=$code): ${lastLogTail()}"
      )
    }

    Thread({
      val exit = runCatching { proc.waitFor() }.getOrDefault(-1)
      runCatching { drain.join(300) }
      runCatching { configFile.delete() }
      if (!closing.get()) {
        Log.w(TAG, "xray exited unexpectedly (code=$exit)")
        onDied(exit)
      }
    }, "vpn-xray-watch").apply { isDaemon = true }.start()
  }

  @Synchronized
  fun closeBestEffort() {
    closing.set(true)
    closeBestEffortLocked()
  }

  private fun closeBestEffortLocked() {
    closing.set(true)
    val proc = process
    process = null
    if (proc != null) {
      runCatching { proc.destroy() }
      runCatching {
        if (!proc.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
          proc.destroyForcibly()
        }
      }
    }
    runCatching { File(context.filesDir, CONFIG_FILE_NAME).delete() }
  }

  /**
   * Drain xray stdout/stderr through the redactor into the shared log
   * file. The redactor is the last code that sees raw bytes; the file
   * only ever contains sanitized lines.
   */
  private fun drainAndRedact(proc: Process) {
    try {
      proc.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
        for (raw in lines) {
          if (closing.get() && !proc.isAlive) break
          appendRedacted(raw)
        }
      }
    } catch (_: Exception) {
      // pipe closed — engine is going away
    }
  }

  private val logBuffer = ArrayDeque<String>()

  /**
   * xray needs geoip.dat / geosite.dat on a real filesystem path —
   * APK assets are not readable by a spawned process. Copy them from
   * assets to filesDir/xray-assets once (marker file guards repeats);
   * the directory is what XRAY_LOCATION_ASSET points at.
   */
  private fun ensureGeodataDir(context: Context): String {
    val dir = File(context.filesDir, "xray-assets")
    val marker = File(dir, ".copied")
    val missing = listOf("geoip.dat", "geosite.dat").any { !File(dir, it).exists() }
    if (!marker.exists() || missing) {
      dir.mkdirs()
      for (name in listOf("geoip.dat", "geosite.dat")) {
        context.assets.open(name).use { input ->
          File(dir, name).outputStream().use { output -> input.copyTo(output) }
        }
      }
      marker.writeText("v1")
      Log.i(TAG, "geodata staged into ${dir.absolutePath}")
    }
    return dir.absolutePath
  }

  @Synchronized
  private fun appendRedacted(raw: String) {
    // redact() returns null for lines that must be dropped entirely.
    val redacted = XrayLogRedactor.redact(raw) ?: return
    logBuffer.addLast(redacted)
    // Mirror sanitized engine lines into logcat while debugging the
    // routing chain on-device (2026-08-22).
    Log.i(TAG, "xray| $redacted")
    while (logBuffer.size > 64) logBuffer.removeFirst()
    runCatching {
      val file = CloakwireVpnService.logFile(context)
      file.parentFile?.mkdirs()
      // Keep the tail file bounded: rotate past 256 KiB.
      if (file.exists() && file.length() > 256 * 1024) file.delete()
      file.appendText(redacted + "\n")
    }
  }

  @Synchronized
  private fun lastLogTail(): String =
    logBuffer.takeLast(5).joinToString(" | ")
}
