package app.cloakwire.client.vpn
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProbeConfigTest {
 private fun sing()=JSONObject("""{"log":{"output":"secret.log"},"experimental":{"clash_api":{"external_controller":"0.0.0.0:9999"}},"inbounds":[{"type":"tun"}],"dns":{"servers":[{"type":"local","tag":"dns"}]},"route":{"final":"server","default_domain_resolver":"dns","rules":[{"action":"route","outbound":"direct"}]},"outbounds":[{"type":"vless","tag":"server","server":"host.invalid","server_port":443,"uuid":"SECRET"},{"type":"direct","tag":"direct"}]}""")
 @Test fun private_copy_preserves_profile_dns_and_removes_system_side_effects() {
  val original=sing();val before=original.toString()
  val result=ProbeConfig.singbox(original,"server",12345,"password")
  assertEquals(before,original.toString())
  assertTrue(original.getJSONObject("dns").similar(result.getJSONObject("dns")))
  assertFalse(result.has("experimental"))
  assertEquals("127.0.0.1",result.getJSONArray("inbounds").getJSONObject(0).getString("listen"))
  assertEquals("server",result.getJSONObject("route").getString("final"))
  assertFalse(result.toString().contains("secret.log"))
  assertEquals("SECRET",result.getJSONArray("outbounds").getJSONObject(0).getString("uuid"))
 }
 @Test fun no_direct_or_dynamic_target_can_be_reported_as_server_health() {
  assertThrows(IllegalArgumentException::class.java){ProbeConfig.singbox(sing(),"direct",12345,"password")}
  val cfg=sing();cfg.getJSONArray("outbounds").getJSONObject(0).put("type","urltest")
  assertThrows(IllegalArgumentException::class.java){ProbeConfig.singbox(cfg,"server",12345,"password")}
 }
 @Test fun provider_binding_and_dns_ruleset_are_not_silently_rewritten() {
  val cfg=sing();cfg.getJSONArray("outbounds").getJSONObject(0).put("bind_interface","vpn")
  assertThrows(IllegalArgumentException::class.java){ProbeConfig.singbox(cfg,"server",12345,"password")}
  val dns=sing();dns.getJSONObject("dns").put("rules",org.json.JSONArray("""[{"rule_set":["provider"]}]"""))
  assertThrows(IllegalArgumentException::class.java){ProbeConfig.singbox(dns,"server",12345,"password")}
 }
 @Test fun xray_uses_only_private_physical_dialer_and_preserves_reality() {
  val cfg=JSONObject("""{"outbounds":[{"tag":"p","protocol":"vless","settings":{"vnext":[{"address":"host.invalid","port":443,"users":[{"id":"SECRET"}]}]},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"fingerprint":"firefox","serverName":"host.invalid"}}}]}""")
  val result=ProbeConfig.xray(cfg,"p",12345,"password",12346,"dial-password")
  val outbound=result.getJSONArray("outbounds").getJSONObject(0)
  assertEquals("firefox",outbound.getJSONObject("streamSettings").getJSONObject("realitySettings").getString("fingerprint"))
  assertEquals("cw-probe-dialer",outbound.getJSONObject("streamSettings").getJSONObject("sockopt").getString("dialerProxy"))
  assertEquals(2,result.getJSONArray("outbounds").length())
  cfg.put("dns",JSONObject("""{"servers":["8.8.8.8"]}"""))
  assertThrows(IllegalArgumentException::class.java){ProbeConfig.xray(cfg,"p",12345,"password",12346,"dial-password")}
 }
 @Test fun target_selection_rejects_ambiguous_ready_profiles() {
  assertEquals("server",ProbeConfig.target(sing(),"singbox",""))
  val cfg=sing();cfg.getJSONArray("outbounds").put(JSONObject("""{"type":"trojan","tag":"other"}"""))
  assertThrows(IllegalArgumentException::class.java){ProbeConfig.target(cfg,"singbox","")}
 }
}
