package app.cloakwire.client.vpn

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * Real end-to-end latency runner (2026-08-21 rebuild).
 *
 * Rust (`xray_config::test_config`) builds a short-lived tester
 * config: one loopback socks inbound per profile, each pinned to its
 * own proxy outbound via inboundTag routing. This class spawns that
 * config as a temporary xray process, pulls `generate_204` through
 * every inbound in parallel, and reports tag → milliseconds (null =
 * timeout / failure).
 *
 * No protected chain and no protect() needed: the app package is
 * always excluded from the TUN, so the tester's dials bypass an
 * active tunnel by themselves. Works with the VPN up and down.
 *
 * Concurrency: one xray process per run, [PARALLELISM] concurrent
 * HTTP probes, 5 s timeout each. The whole run is bounded by
 * ceil(n / PARALLELISM) * TIMEOUT_MS worst case.
 */
object LatencyTester {

  private const val TAG = "LatencyTester"
  private const val PROBE_URL = "http://www.gstatic.com/generate_204"
  private const val TIMEOUT_MS = 5_000
  private const val PARALLELISM = 6
  private const val STARTUP_WAIT_MS = 1_200L
  private const val CONFIG_FILE_NAME = "xray-latency-test.json"

  /**
   * Run the test. `config` is the full tester config JSON from Rust;
   * `entries` is the port→tag map as `[{"tag": ..., "port": ...}]`.
   * Returns a JSON array of `{"tag": ..., "ms": number|null}`.
   */
  fun run(context: Context, config: String, entries: JSONArray): JSONArray {
    val results = JSONArray()
    if (entries.length() == 0) return results

    val configFile = File(context.filesDir, CONFIG_FILE_NAME)
    val process = try {
      configFile.writeText(config)
      val pb = ProcessBuilder(
        File(context.applicationInfo.nativeLibraryDir, XrayEngine.BINARY_NAME).absolutePath,
        "run", "-c", configFile.absolutePath,
      )
      pb.environment()["XRAY_LOCATION_ASSET"] =
        File(context.filesDir, "xray-assets").absolutePath
      pb.redirectErrorStream(true)
      pb.start()
    } catch (e: Exception) {
      Log.w(TAG, "tester spawn failed: ${e.message}")
      return failAll(entries)
    }

    try {
      // Give the inbounds a moment to come up. A readiness probe per
      // port would be nicer, but a fixed short wait keeps the runner
      // simple; the per-probe timeout absorbs the tail.
      Thread.sleep(STARTUP_WAIT_MS)
      if (!process.isAlive) {
        Log.w(TAG, "tester died during startup (exit=${process.exitValue()})")
        return failAll(entries)
      }

      val executor = Executors.newFixedThreadPool(PARALLELISM) { r ->
        Thread(r, "latency-probe").apply { isDaemon = true }
      }
      val futures = ArrayList<Future<Pair<String, Long?>>>(entries.length())
      for (i in 0 until entries.length()) {
        val entry = entries.optJSONObject(i) ?: continue
        val tag = entry.optString("tag")
        val port = entry.optInt("port")
        if (tag.isEmpty() || port <= 0) continue
        futures.add(
          executor.submit(
            java.util.concurrent.Callable { probe(port, tag) }
          )
        )
      }
      for (future in futures) {
        val pair = try {
          future.get()
        } catch (_: Exception) {
          null
        } ?: continue
        val (tag, ms) = pair
        if (tag.isNotEmpty()) {
          val row = JSONObject()
          row.put("tag", tag)
          row.put("ms", ms ?: JSONObject.NULL)
          results.put(row)
        }
      }
      executor.shutdownNow()
    } finally {
      runCatching { process.destroy() }
      runCatching {
        if (!process.waitFor(2, TimeUnit.SECONDS)) process.destroyForcibly()
      }
      runCatching { configFile.delete() }
    }
    return results
  }

  /** One HTTP probe through the given loopback socks port. */
  private fun probe(port: Int, tag: String): Pair<String, Long?> {
    val start = System.currentTimeMillis()
    return try {
      val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port))
      val connection = URL(PROBE_URL).openConnection(proxy) as java.net.HttpURLConnection
      connection.connectTimeout = TIMEOUT_MS
      connection.readTimeout = TIMEOUT_MS
      connection.useCaches = false
      val code = connection.responseCode
      connection.disconnect()
      // 204 (or any success / redirect) proves the full chain works.
      if (code in 200..399) tag to (System.currentTimeMillis() - start) else tag to null
    } catch (e: Exception) {
      Log.i(TAG, "probe failed via :$port (${e.message})")
      tag to null
    }
  }

  private fun failAll(entries: JSONArray): JSONArray {
    val results = JSONArray()
    for (i in 0 until entries.length()) {
      val entry = entries.optJSONObject(i) ?: continue
      val row = JSONObject()
      row.put("tag", entry.optString("tag"))
      row.put("ms", JSONObject.NULL)
      results.put(row)
    }
    return results
  }
}
