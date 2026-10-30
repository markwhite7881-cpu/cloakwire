package app.cloakwire.client.vpn

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/** Short-lived checker subprocess only; never touches the active engine or its files. */
internal object ProcessProfileCheck {
  private val slot = Semaphore(1)
  private const val MAX_DIAGNOSTIC_BYTES = 64 * 1024

  fun check(config: String, directory: File, timeoutMs: Long, start: (File) -> Process) {
    if (!slot.tryAcquire()) throw ProfileCheckException(ProfileCheckKind.UNAVAILABLE)
    var candidate: File? = null
    var process: Process? = null
    var reader: Thread? = null
    val output = ByteArrayOutputStream()
    try {
      val file = File.createTempFile("profile-check-", ".json", directory)
      candidate = file
      file.writeText(config)
      val child = try { start(file) } catch (_: IOException) {
        throw ProfileCheckException(ProfileCheckKind.UNAVAILABLE)
      }
      process = child
      reader = Thread({
        try {
          child.inputStream.use { input ->
            val buffer = ByteArray(4096)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              synchronized(output) {
                val keep = minOf(count, MAX_DIAGNOSTIC_BYTES - output.size())
                if (keep > 0) output.write(buffer, 0, keep)
              }
            }
          }
        } catch (_: IOException) { /* Closed during bounded cleanup. */ }
      }, "vpn-profile-check-output").apply { isDaemon = true; start() }
      if (!child.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
        throw ProfileCheckException(ProfileCheckKind.TIMEOUT)
      }
      reader.join(250)
      if (child.exitValue() != 0) {
        val raw = synchronized(output) { output.toString(Charsets.UTF_8.name()) }
        throw ProfilePreflight.failure(IllegalStateException(raw))
      }
    } catch (error: ProfileCheckException) {
      throw error
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      throw ProfileCheckException(ProfileCheckKind.FAILED)
    } catch (_: IOException) {
      throw ProfileCheckException(ProfileCheckKind.UNAVAILABLE)
    } finally {
      process?.let { child ->
        if (child.isAlive) {
          child.destroyForcibly()
          runCatching { child.waitFor(1, TimeUnit.SECONDS) }
        }
        runCatching { child.inputStream.close() }
        runCatching { child.errorStream.close() }
        runCatching { child.outputStream.close() }
      }
      runCatching { reader?.join(250) }
      candidate?.delete()
      slot.release()
    }
  }
}
