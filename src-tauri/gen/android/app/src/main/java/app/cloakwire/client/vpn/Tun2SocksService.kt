package app.cloakwire.client.vpn

import android.content.Context
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.File

/**
 * Thin wrapper around the hev-socks5-tunnel C library
 * (`libhev-socks5-tunnel.so` staged under `jniLibs/arm64-v8a/`).
 *
 * The C side reads IP packets from a TUN file descriptor and
 * forwards them over a SOCKS5 connection to a local proxy. This
 * class generates a per-session YAML config, hands the file plus
 * the TUN fd to the native entry point, and surfaces the library's
 * state and byte counters to the rest of the app.
 *
 * The JNI surface itself lives in [hev.htproxy.TProxyService] —
 * that object's class loader triggers `JNI_OnLoad`, which calls
 * `FindClass("hev/htproxy/TProxyService")` and `RegisterNatives`
 * to bind the four TProxy* methods. This class only forwards
 * calls to those static natives and never touches `loadLibrary`
 * itself, so the C side sees exactly one FindClass/RegisterNatives
 * pair per process.
 *
 * Lifecycle: instances are cheap to construct, but only one
 * [start] / [stop] pair can run at a time — both are
 * `@Synchronized` to keep the underlying tunnel from being
 * entered twice. The service calling this wrapper is expected
 * to own the [ParcelFileDescriptor] and to close it on stop;
 * this class never closes the descriptor itself.
 */
class Tun2SocksService(
  private val context: Context,
) {

  private companion object {
    private const val TAG = "Tun2SocksService"
    private const val CONFIG_FILE_NAME = "hev-socks5-tunnel.yaml"
  }

  /**
   * Write a fresh hev-socks5-tunnel YAML config to
   * `filesDir/hev-socks5-tunnel.yaml` and hand the file plus the
   * TUN file descriptor to the C entry point. Returns whatever
   * the native call reports; on any I/O failure (unable to
   * create the config, etc.) the exception is logged and `false`
   * is returned so the caller can keep its own state machine
   * consistent without a checked-exception surface.
   */
  @Synchronized
  fun start(
    parcelFileDescriptor: ParcelFileDescriptor,
    socksPort: Int = 10808,
    mtu: Int = 1500,
    ipv4Address: String = "10.0.0.2",
  ): Boolean {
    val configFile = try {
      val file = File(context.filesDir, CONFIG_FILE_NAME)
      file.writeText(buildConfig(socksPort, mtu, ipv4Address))
      Log.i(TAG, "config written: ${file.absolutePath}")
      file
    } catch (e: Exception) {
      Log.e(TAG, "failed to write hev-socks5-tunnel config: ${e.message}", e)
      return false
    }

    val result = try {
      hev.htproxy.TProxyService.TProxyStartService(
        configFile.absolutePath,
        parcelFileDescriptor.fd,
      )
    } catch (e: Exception) {
      Log.e(TAG, "TProxyStartService threw: ${e.message}", e)
      false
    }
    Log.i(TAG, "TProxyStartService returned: $result")
    return result
  }

  /**
   * Stop the running tunnel. Best-effort: any exception from the
   * native call is logged, swallowed, and reported as `false`.
   */
  @Synchronized
  fun stop(): Boolean {
    return try {
      val result = hev.htproxy.TProxyService.TProxyStopService()
      Log.i(TAG, "TProxyStopService returned: $result")
      result
    } catch (e: Exception) {
      Log.e(TAG, "TProxyStopService threw: ${e.message}", e)
      false
    }
  }

  /**
   * Query the C library for its current running state. Exceptions
   * are logged and reported as `false` (treat "unknown" the same
   * as "not running" — the caller will normally be about to call
   * [stop] anyway).
   */
  @Synchronized
  fun isRunning(): Boolean {
    return try {
      hev.htproxy.TProxyService.TProxyIsRunning()
    } catch (e: Exception) {
      Log.e(TAG, "TProxyIsRunning threw: ${e.message}", e)
      false
    }
  }

  /**
   * Read byte counters from the C library. Returns `null` if the
   * native call throws (e.g. the library is not loaded, or the
   * tunnel was never started) — the caller is expected to handle
   * the null case and not assume stats are always available.
   */
  fun getStats(): LongArray? {
    return try {
      hev.htproxy.TProxyService.TProxyGetStats()
    } catch (e: Exception) {
      Log.e(TAG, "TProxyGetStats threw: ${e.message}", e)
      null
    }
  }

  /**
   * Assemble the hev-socks5-tunnel YAML. The shape is fixed by
   * the C library's parser: a top-level `tunnel:` block with
   * `mtu` and `ipv4` and a `socks5:` block with `port`,
   * `address` (loopback) and `udp` mode.
   */
  private fun buildConfig(socksPort: Int, mtu: Int, ipv4Address: String): String {
    return buildString {
      appendLine("tunnel:")
      appendLine("  mtu: $mtu")
      appendLine("  ipv4: $ipv4Address")
      appendLine("socks5:")
      appendLine("  port: $socksPort")
      appendLine("  address: 127.0.0.1")
      appendLine("  udp: 'udp'")
    }
  }
}
