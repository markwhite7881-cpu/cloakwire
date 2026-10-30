package app.cloakwire.client.vpn

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ProfilePreflightTest {
  @Test fun `only explicit configuration diagnostics are classified and no raw values escape`() {
    val cases = listOf(
      "initialize DNS server[0]: address_resolver not found: secret-resolver" to "profile_check_dns",
      "default domain resolver not found: secret-resolver" to "profile_check_dns",
      "parse route rule[0]: rule-set not found: secret-rules" to "profile_check_ruleset",
      "decode config: json: unknown field \"secret-field\"" to "profile_check_unsupported",
      "unknown outbound type: secret-kind" to "profile_check_unsupported",
      "invalid character 's' looking for beginning of value" to "profile_check_invalid",
      "dial tcp: lookup private-provider.example: no such host" to "profile_check_failed",
      "unknown DNS server: private-resolver" to "profile_check_dns",
      "initialize rule-set[0]: open /private/provider.srs: no such file or directory" to "profile_check_ruleset",
      "failed to load geosite.dat: no such file" to "profile_check_ruleset",
      "decode config: EOF" to "profile_check_invalid",
      "unknown action: secret-action" to "profile_check_unsupported",
      "unknown config id: private-protocol" to "profile_check_unsupported",
      "unknown protocol: private-protocol" to "profile_check_unsupported",
      "provider DNS response contains password=secret" to "profile_check_failed",
      "something secret and unexpected" to "profile_check_failed",
    )
    for ((raw, expected) in cases) {
      assertEquals(expected, ProfilePreflight.classify(raw))
    }
  }

  @Test fun `failed validation leaves saved config and running connection untouched`() {
    val directory = Files.createTempDirectory("vpn-preflight-test").toFile()
    try {
      val saved = File(directory, "last.json").apply { writeText("known-good") }
      var running = true
      val failure = assertThrows(ProfileCheckException::class.java) {
        ProfilePreflight.run(
          prepare = { "prepared-secret-config" },
          check = { throw IllegalStateException("initialize DNS server[0]: address_resolver not found: private-name") },
          handoff = { saved.writeText(it); running = false },
        )
      }
      assertEquals("profile_check_dns", failure.message)
      assertNull(failure.cause)
      assertEquals("known-good", saved.readText())
      assertTrue(running)
    } finally { directory.deleteRecursively() }
  }

  @Test fun `handoff receives exactly the configuration accepted by checker`() {
    val seen = mutableListOf<String>()
    var saved = "old"
    ProfilePreflight.run(
      prepare = { "normalized-with-android-app-policy" },
      check = { config -> assertEquals("old", saved); seen.add(config) },
      handoff = { config -> assertEquals(listOf("normalized-with-android-app-policy"), seen); saved = config },
    )
    assertEquals("normalized-with-android-app-policy", saved)
  }

  @Test fun `malformed JSON preparation exposes only the invalid token`() {
    val failure = assertThrows(ProfileCheckException::class.java) {
      ProfilePreflight.run(
        prepare = { AndroidEngineConfig.singBox("private broken JSON", "[]", "exclude", "self", "/private/box.log") },
        check = { fail("checker must not run for malformed JSON") },
        handoff = { fail("must not persist invalid JSON") },
      )
    }
    assertEquals("profile_check_invalid", failure.message)
  }

  @Test fun `native timeout is bounded and another request cannot accumulate workers`() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val checker = BoundedNativeProfileCheck()
    val first = assertThrows(ProfileCheckException::class.java) {
      checker.check(50) {
        entered.countDown()
        while (release.count > 0) {
          try { release.await(20, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { }
        }
      }
    }
    try {
      assertEquals("profile_check_timeout", first.message)
      assertTrue(entered.await(1, TimeUnit.SECONDS))
      val second = assertThrows(ProfileCheckException::class.java) {
        checker.check(50) { fail("must not spawn another native worker") }
      }
      assertEquals("profile_check_unavailable", second.message)
    } finally { release.countDown() }
  }
  @Test fun `stop during checking prevents a later service handoff`() {
    val pending = PendingProfileStarts()
    val request = pending.begin()
    var saved = "known-good"
    var running = true
    val cancelled = assertThrows(ProfileCheckException::class.java) {
      ProfilePreflight.run(
        prepare = { "candidate" },
        check = { pending.cancel() },
        handoff = { config -> pending.handoff(request) { saved = config; running = false } },
      )
    }
    assertEquals("profile_check_cancelled", cancelled.message)
    assertEquals("known-good", saved)
    assertTrue(running)
    assertFalse(pending.isCurrent(request))
  }

  @Test fun `only most recent start can hand off after checks finish out of order`() {
    val pending = PendingProfileStarts()
    val first = pending.begin()
    val second = pending.begin()
    var active = "old"
    pending.handoff(second) { active = "latest" }
    val cancelled = assertThrows(ProfileCheckException::class.java) {
      pending.handoff(first) { active = "stale" }
    }
    assertEquals("profile_check_cancelled", cancelled.message)
    assertEquals("latest", active)
    assertTrue(pending.isCurrent(second))
    assertFalse(pending.isCurrent(first))
  }

}
