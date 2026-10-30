package app.cloakwire.client.vpn

import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal enum class ProfileCheckKind(val token: String) {
  DNS("profile_check_dns"), RULESET("profile_check_ruleset"),
  UNSUPPORTED("profile_check_unsupported"), INVALID("profile_check_invalid"),
  UNAVAILABLE("profile_check_unavailable"), TIMEOUT("profile_check_timeout"),
  FAILED("profile_check_failed"), CANCELLED("profile_check_cancelled"),
}

/** The exception deliberately has no raw diagnostic or cause. */
internal class ProfileCheckException(kind: ProfileCheckKind) : Exception(kind.token)

internal object ProfilePreflight {
  fun classify(raw: String): String = classifyKind(raw).token

  private fun classifyKind(raw: String): ProfileCheckKind {
    val text = raw.lowercase(Locale.ROOT)
    return when {
      listOf(
        "address_resolver not found", "address resolver not found", "missing address resolver",
        "domain_resolver not found", "domain resolver not found", "missing default domain resolver",
        "dns server not found", "unknown dns server", "non-existent dns server",
        "missing default dns server", "failed to build dns config",
      ).any(text::contains) -> ProfileCheckKind.DNS
      listOf("rule-set", "rule_set", "rule set", "geoip.dat", "geosite.dat").any(text::contains) &&
        listOf("not found", "no such file", "invalid", "failed to", "missing", "parse", "load", "decode").any(text::contains) -> ProfileCheckKind.RULESET
      listOf(
        "unknown field", "unknown outbound type", "unknown inbound type", "unknown rule action", "unknown action",
        "unknown config id", "unknown protocol",
        "unsupported option", "unsupported field", "unsupported protocol", "not supported on android",
      ).any(text::contains) -> ProfileCheckKind.UNSUPPORTED
      listOf(
        "invalid character", "unexpected end of json", "unexpected eof", "invalid configuration",
        "invalid config", "decode config", "failed to parse config", "failed to load config", "invalid port",
        "invalid uuid", "outbound not found", "missing required",
      ).any(text::contains) -> ProfileCheckKind.INVALID
      else -> ProfileCheckKind.FAILED
    }
  }

  fun failure(error: Throwable): ProfileCheckException = when (error) {
    is ProfileCheckException -> error
    is LinkageError -> ProfileCheckException(ProfileCheckKind.UNAVAILABLE)
    else -> ProfileCheckException(classifyKind(error.message.orEmpty()))
  }

  /** Keep every state/file mutation on the far side of a successful check. */
  fun run(prepare: () -> String, check: (String) -> Unit, handoff: (String) -> Unit) {
    val config = try { prepare() } catch (_: Exception) {
      throw ProfileCheckException(ProfileCheckKind.INVALID)
    }
    try { check(config) } catch (error: Exception) {
      throw failure(error)
    } catch (error: LinkageError) {
      throw failure(error)
    }
    try { handoff(config) } catch (error: Exception) {
      throw failure(error)
    }
  }
}

/** A stuck native call occupies at most one daemon; new calls are rejected, never queued. */
internal class BoundedNativeProfileCheck {
  private val worker = ThreadPoolExecutor(
    0, 1, 30L, TimeUnit.SECONDS, SynchronousQueue<Runnable>(),
    { task -> Thread(task, "vpn-profile-check-native").apply { isDaemon = true } },
    ThreadPoolExecutor.AbortPolicy(),
  )

  fun check(timeoutMs: Long, action: () -> Unit) {
    val future = try { worker.submit(Callable { action() }) } catch (_: RejectedExecutionException) {
      throw ProfileCheckException(ProfileCheckKind.UNAVAILABLE)
    }
    try {
      future.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: TimeoutException) {
      future.cancel(true)
      throw ProfileCheckException(ProfileCheckKind.TIMEOUT)
    } catch (_: InterruptedException) {
      future.cancel(true)
      Thread.currentThread().interrupt()
      throw ProfileCheckException(ProfileCheckKind.FAILED)
    } catch (error: ExecutionException) {
      throw ProfilePreflight.failure(error.cause ?: error)
    }
  }
}

/** Serializes the final handoff with stop and superseding start requests. */
internal class PendingProfileStarts {
  private var generation = 0L
  @Synchronized fun begin(): Long = ++generation
  @Synchronized fun cancel() { generation++ }
  @Synchronized fun isCurrent(request: Long): Boolean = request == generation
  @Synchronized fun handoff(request: Long, action: () -> Unit) {
    if (request != generation) throw ProfileCheckException(ProfileCheckKind.CANCELLED)
    action()
  }
}
