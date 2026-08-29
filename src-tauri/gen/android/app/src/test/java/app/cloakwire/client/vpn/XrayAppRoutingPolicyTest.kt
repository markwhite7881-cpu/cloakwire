package app.cloakwire.client.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class XrayAppRoutingPolicyTest {

  private val ownPackage = "app.cloakwire.client"

  @Test
  fun `include mode uses only an allow-list and omits VPN owner`() {
    val policy = XrayAppRoutingPolicy.create(
      listOf("org.telegram.messenger", ownPackage, "com.whatsapp"),
      "include",
      ownPackage,
    )

    assertEquals(
      listOf("org.telegram.messenger", "com.whatsapp"),
      policy.allowedPackages,
    )
    assertTrue(policy.disallowedPackages.isEmpty())
  }

  @Test
  fun `exclude mode uses only a deny-list and adds VPN owner`() {
    val policy = XrayAppRoutingPolicy.create(
      listOf("com.whatsapp", "com.whatsapp"),
      "exclude",
      ownPackage,
    )

    assertTrue(policy.allowedPackages.isEmpty())
    assertEquals(
      listOf("com.whatsapp", ownPackage),
      policy.disallowedPackages,
    )
  }

  @Test
  fun `all apps mode excludes only VPN owner`() {
    val policy = XrayAppRoutingPolicy.create(emptyList(), "exclude", ownPackage)

    assertTrue(policy.allowedPackages.isEmpty())
    assertEquals(listOf(ownPackage), policy.disallowedPackages)
  }

  @Test
  fun `empty include mode fails instead of silently routing all apps`() {
    assertThrows(IllegalArgumentException::class.java) {
      XrayAppRoutingPolicy.create(emptyList(), "include", ownPackage)
    }
  }
}
