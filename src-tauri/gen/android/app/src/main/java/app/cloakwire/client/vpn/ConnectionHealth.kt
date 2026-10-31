package app.cloakwire.client.vpn

import java.util.Locale
import org.json.JSONObject

internal sealed class ProfileRef {
  data class Manual(val id: String) : ProfileRef()
  data class Subscription(val subscriptionId: String, val linkKey: String) : ProfileRef()
  data class Ready(val subscriptionId: String, val childKey: String) : ProfileRef()
  data class Auto(val snapshotId: String) : ProfileRef()

  fun toJson(): JSONObject = when (this) {
    is Manual -> JSONObject().put("kind", "manual").put("id", id)
    is Subscription -> JSONObject().put("kind", "subscription").put("subscription_id", subscriptionId).put("link_key", linkKey)
    is Ready -> JSONObject().put("kind", "ready").put("subscription_id", subscriptionId).put("child_key", childKey)
    is Auto -> JSONObject().put("kind", "auto").put("snapshot_id", snapshotId)
  }
  companion object {
    fun fromJson(value: JSONObject): ProfileRef = when (strictString(value, "kind")) {
      "manual" -> Manual(strictString(value, "id"))
      "subscription" -> Subscription(strictString(value, "subscription_id"), strictString(value, "link_key"))
      "ready" -> Ready(strictString(value, "subscription_id"), strictString(value, "child_key"))
      "auto" -> Auto(strictString(value, "snapshot_id"))
      else -> throw IllegalArgumentException("invalid_health_contract")
    }
  }
}
internal data class SessionIdentity(
  val profileRef: ProfileRef, val profileRevision: String, val runId: String?,
  val networkGeneration: String, val effectiveOutboundRevision: String?,
) {
  fun matches(other: SessionIdentity): Boolean = this == other
  fun toJson(): JSONObject = JSONObject()
    .put("profile_ref", profileRef.toJson()).put("profile_revision", profileRevision)
    .put("run_id", runId ?: JSONObject.NULL).put("network_generation", networkGeneration)
    .put("effective_outbound_revision", effectiveOutboundRevision ?: JSONObject.NULL)
}
internal enum class HealthScope { SELECTED_PROFILE, ACTIVE_SESSION }
internal enum class HealthStage { PREPARING, CONNECTING, VERIFYING, COMPLETE }
internal enum class HealthOutcome { UNKNOWN, CHECKING, HEALTHY, FAILED, UNAVAILABLE, CANCELLED }
internal enum class HealthIssue {
  NETWORK_UNAVAILABLE, ENDPOINT_UNREACHABLE, TIMEOUT, REALITY_VERIFICATION,
  TLS_VERIFICATION, DNS, AUTHENTICATION, ENGINE_UNAVAILABLE, UNSUPPORTED_PROBE,
  PROBE_TARGET_UNAVAILABLE, UNKNOWN,
}
internal data class ConnectionHealth(
  val identity: SessionIdentity, val operationId: String, val scope: HealthScope,
  val stage: HealthStage, val outcome: HealthOutcome, val issue: HealthIssue?,
  val checkedAt: String?, val latencyMs: Long?,
) {
  fun toJson(): JSONObject = identity.toJson()
    .put("operation_id", operationId).put("scope", scope.wire()).put("stage", stage.wire())
    .put("outcome", outcome.wire()).put("issue", issue?.wire() ?: JSONObject.NULL)
    .put("checked_at", checkedAt ?: JSONObject.NULL).put("latency_ms", latencyMs ?: JSONObject.NULL)
  companion object {
    fun fromJson(value: JSONObject): ConnectionHealth {
      val latency = value.opt("latency_ms").let {
        if (it == null || it == JSONObject.NULL) null else {
          require(it is Number && it.toLong() >= 0 && it.toDouble() == it.toLong().toDouble()) { "invalid_health_contract" }
          it.toLong()
        }
      }
      return ConnectionHealth(
        SessionIdentity(
          ProfileRef.fromJson(value.getJSONObject("profile_ref")),
          strictString(value, "profile_revision"), nullableString(value, "run_id"),
          strictString(value, "network_generation"), nullableString(value, "effective_outbound_revision"),
        ),
        strictString(value, "operation_id"), wireEnum<HealthScope>(strictString(value, "scope")),
        wireEnum<HealthStage>(strictString(value, "stage")), wireEnum<HealthOutcome>(strictString(value, "outcome")),
        nullableString(value, "issue")?.let { wireEnum<HealthIssue>(it) },
        nullableString(value, "checked_at"), latency,
      )
    }
  }
}
private fun Enum<*>.wire(): String = name.lowercase(Locale.ROOT)
private inline fun <reified T : Enum<T>> wireEnum(value: String): T =
  enumValues<T>().find { it.name.lowercase(Locale.ROOT) == value }
    ?: throw IllegalArgumentException("invalid_health_contract")
private fun strictString(value: JSONObject, key: String): String {
  val item = value.opt(key)
  require(item is String && item.isNotEmpty()) { "invalid_health_contract" }
  return item
}
private fun nullableString(value: JSONObject, key: String): String? {
  if (value.isNull(key)) return null
  return strictString(value, key)
}
