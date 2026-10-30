package app.cloakwire.client.vpn

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AndroidEngineConfigTest {
  private val own = "app.cloakwire.client"
  private val fixture = """{
    "outbounds":[{"type":"direct","tag":"direct"},{"type":"vless","tag":"provider","server":"private.example","uuid":"secret-id"}],
    "dns":{"servers":[{"type":"udp","tag":"remote","server":"1.1.1.1"}],"final":"remote"},
    "route":{"final":"provider","rule_set":[{"tag":"ads","type":"remote","format":"binary","url":"https://private.example/rules"}],"rules":[{"inbound":["provider-tun"],"rule_set":["ads"],"action":"route","outbound":"provider"}]},
    "inbounds":[{"type":"tun","tag":"provider-tun","inet4_address":"10.0.0.1/30","include_package":["old.app"],"stack":"system"}],
    "log":{"level":"warn"}
  }"""

  @Test fun `normalizes Android TUN and application policy while preserving provider routing and DNS`() {
    val root = JSONObject(AndroidEngineConfig.singBox(fixture, "[\"org.telegram.messenger\",\"app.cloakwire.client\"]", "include", own, "/private/box.log"))
    val tun = root.getJSONArray("inbounds").getJSONObject(0)
    assertEquals("provider-tun", tun.getString("tag"))
    assertEquals("172.19.0.1/30", tun.getJSONArray("address").getString(0))
    assertFalse(tun.has("inet4_address"))
    assertEquals("gvisor", tun.getString("stack"))
    assertEquals(9000, tun.getInt("mtu"))
    assertTrue(tun.getBoolean("auto_route"))
    assertFalse(tun.getBoolean("strict_route"))
    assertEquals("org.telegram.messenger", tun.getJSONArray("include_package").getString(0))
    assertEquals(1, tun.getJSONArray("include_package").length())
    assertFalse(tun.has("exclude_package"))
    assertEquals("remote", root.getJSONObject("dns").getString("final"))
    assertEquals("1.1.1.1", root.getJSONObject("dns").getJSONArray("servers").getJSONObject(0).getString("server"))
    val route = root.getJSONObject("route")
    assertEquals("provider", route.getString("final"))
    assertEquals("https://private.example/rules", route.getJSONArray("rule_set").getJSONObject(0).getString("url"))
    assertEquals("provider-tun", route.getJSONArray("rules").getJSONObject(2).getJSONArray("inbound").getString(0))
    assertEquals("secret-id", root.getJSONArray("outbounds").getJSONObject(1).getString("uuid"))
    assertEquals("/private/box.log", root.getJSONObject("log").getString("output"))
    assertEquals("warn", root.getJSONObject("log").getString("level"))
  }

  @Test fun `normalization is repeatable without duplicating DNS and private bypass rules`() {
    val once = AndroidEngineConfig.singBox(fixture, "[]", "exclude", own, "/private/box.log")
    val twice = AndroidEngineConfig.singBox(once, "[]", "exclude", own, "/private/box.log")
    assertEquals(JSONObject(once).toString(), JSONObject(twice).toString())
    val tun = JSONObject(twice).getJSONArray("inbounds").getJSONObject(0)
    assertEquals(own, tun.getJSONArray("exclude_package").getString(0))
  }

  @Test fun `empty include policy fails before a VPN can silently route all apps`() {
    assertThrows(IllegalArgumentException::class.java) {
      AndroidEngineConfig.singBox(fixture, "[]", "include", own, "/private/box.log")
    }
  }

  @Test fun `Xray preparation retains DNS routing and outbound credentials`() {
    val raw = """{"outbounds":[{"protocol":"vless","settings":{"id":"secret"}}],"dns":{"servers":["1.1.1.1"]},"routing":{"domainStrategy":"IPIfNonMatch"}}"""
    val result = JSONObject(AndroidEngineConfig.xray(raw, "/private/xray.log"))
    assertEquals("secret", result.getJSONArray("outbounds").getJSONObject(0).getJSONObject("settings").getString("id"))
    assertEquals("IPIfNonMatch", result.getJSONObject("routing").getString("domainStrategy"))
    assertEquals("1.1.1.1", result.getJSONObject("dns").getJSONArray("servers").getString(0))
    assertEquals("/private/xray.log", result.getJSONObject("log").getString("output"))
  }
  @Test fun `checker logging is muted without touching runtime log or provider data`() {
    val prepared = AndroidEngineConfig.singBox(fixture, "[]", "exclude", own, "/active/box.log")
    val check = JSONObject(AndroidEngineConfig.forCheck(prepared, "sing-box"))
    assertTrue(check.getJSONObject("log").getBoolean("disabled"))
    assertFalse(check.getJSONObject("log").has("output"))
    assertEquals("remote", check.getJSONObject("dns").getString("final"))
    assertEquals("provider", check.getJSONObject("route").getString("final"))
    assertEquals("secret-id", check.getJSONArray("outbounds").getJSONObject(1).getString("uuid"))
    assertEquals("/active/box.log", JSONObject(prepared).getJSONObject("log").getString("output"))
    val xray = JSONObject(AndroidEngineConfig.forCheck("""{"inbounds":[{"tag":"provider-http","protocol":"http","listen":"127.0.0.1","port":10809}],"outbounds":[],"log":{"access":"/active/access.log","error":"/active/error.log","loglevel":"debug","dnsLog":true}}""", "xray"))
    assertEquals("provider-http", xray.getJSONArray("inbounds").getJSONObject(0).getString("tag"))
    assertEquals("http", xray.getJSONArray("inbounds").getJSONObject(0).getString("protocol"))
    assertEquals(10809, xray.getJSONArray("inbounds").getJSONObject(0).getInt("port"))
    assertEquals("none", xray.getJSONObject("log").getString("loglevel"))
    assertEquals("none", xray.getJSONObject("log").getString("access"))
    assertEquals("none", xray.getJSONObject("log").getString("error"))
    assertFalse(xray.getJSONObject("log").getBoolean("dnsLog"))
  }

}
