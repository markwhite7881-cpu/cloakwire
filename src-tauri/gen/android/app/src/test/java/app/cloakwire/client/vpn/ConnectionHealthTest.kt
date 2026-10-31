package app.cloakwire.client.vpn

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConnectionHealthTest {
  private fun fixture(): JSONObject {
    var directory: File? = File(System.getProperty("user.dir"))
    while (directory != null) {
      val file = File(directory, "src/lib/fixtures/connection-health.json")
      if (file.isFile) return JSONObject(file.readText())
      directory = directory.parentFile
    }
    error("Shared connection-health fixture not found")
  }
  @Test fun `wire IDs retain all digits and unknown raw fields are not returned`() {
    val source = fixture().put("stderr", "SECRET-SENTINEL")
    val health = ConnectionHealth.fromJson(source)
    val wire = health.toJson()
    assertEquals("18446744073709551615", wire.getString("run_id"))
    assertEquals("9007199254740993", wire.getString("network_generation"))
    assertFalse(wire.toString().contains("SECRET-SENTINEL"))
    assertTrue(fixture().similar(wire))
    assertEquals(35L, wire.getLong("latency_ms"))
    assertEquals("healthy", wire.getString("outcome"))
    assertEquals("manual", wire.getJSONObject("profile_ref").getString("kind"))
  }
  @Test fun `new revision cannot accept an old health result`() {
    val health = ConnectionHealth.fromJson(fixture())
    assertTrue(health.identity.matches(health.identity))
    assertFalse(health.identity.matches(health.identity.copy(profileRevision = "5")))
    assertFalse(health.identity.matches(health.identity.copy(runId = "1")))
    assertFalse(health.identity.matches(health.identity.copy(networkGeneration = "2")))
  }
  @Test fun `unknown issue and numeric IDs are rejected`() {
    assertThrows(IllegalArgumentException::class.java) {
      ConnectionHealth.fromJson(fixture().put("issue", "SECRET-SENTINEL"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      ConnectionHealth.fromJson(fixture().put("run_id", 123))
    }
  }
}
