package app.cloakwire.client.vpn
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class RecoveryRuntimeConfigTest {
 private val sing="""{"inbounds":[{"type":"tun","tag":"tun"}],"outbounds":[{"type":"vless","tag":"proxy","server":"private","uuid":"secret"},{"type":"direct","tag":"direct"}],"route":{"final":"proxy","rules":[{"domain_suffix":["local"],"outbound":"direct"}]},"dns":{"final":"provider"}}"""
 @Test fun isolated_authenticated_inbound_keeps_provider_routes_and_dns() {
  val wired=RecoveryRuntimeConfig.wire(sing,"sing-box",18081,"private-token")!!
  val json=JSONObject(wired.config);val inbound=json.getJSONArray("inbounds").getJSONObject(1)
  assertEquals("127.0.0.1",inbound.getString("listen"));assertEquals("private-token",inbound.getJSONArray("users").getJSONObject(0).getString("password"))
  val rules=json.getJSONObject("route").getJSONArray("rules")
  assertEquals(wired.tag,rules.getJSONObject(0).getJSONArray("inbound").getString(0))
  assertEquals("direct",rules.getJSONObject(1).getString("outbound"));assertEquals("provider",json.getJSONObject("dns").getString("final"))
  assertEquals("secret",json.getJSONArray("outbounds").getJSONObject(0).getString("uuid"))
 }
 @Test fun selector_and_ambiguous_effective_outbound_are_unavailable_without_mutation() {
  val original=sing.replace("\"final\":\"proxy\"","\"final\":\"selector\"")
  assertNull(RecoveryRuntimeConfig.wire(original,"sing-box",18081,"private-token"))
  assertEquals("selector",JSONObject(original).getJSONObject("route").getString("final"))
 }
 @Test fun generated_single_profile_selector_and_urltest_have_one_provable_effective_leaf() {
  val generated="""{"inbounds":[{"type":"tun","tag":"tun-in"}],"outbounds":[{"type":"urltest","tag":"auto","outbounds":["node"],"url":"https://www.gstatic.com/generate_204","interval":"30s","tolerance":50},{"type":"selector","tag":"proxy","outbounds":["auto","node"],"default":"auto"},{"type":"direct","tag":"direct"},{"type":"block","tag":"block"},{"type":"vless","tag":"node","server":"192.0.2.1","server_port":443,"uuid":"private-id"}],"dns":{"servers":[{"tag":"remote","type":"https","server":"1.1.1.1","detour":"proxy"}],"final":"remote"},"route":{"final":"proxy","auto_detect_interface":true,"rules":[{"ip_is_private":true,"outbound":"direct"}]}}"""
  val wired=RecoveryRuntimeConfig.wire(generated,"sing-box",18081,"private-token")!!
  assertEquals("node",wired.outbound)
  assertEquals("proxy",JSONObject(wired.config).getJSONObject("route").getString("final"))
  assertEquals("auto",JSONObject(wired.config).getJSONArray("outbounds").getJSONObject(1).getString("default"))
  val candidate=RecoveryRuntimeConfig.candidate(generated,"sing-box","node")
  val probe=ProbeConfig.singbox(JSONObject(candidate),"node",19081,"candidate-token")
  assertEquals("node",probe.getJSONObject("dns").getJSONArray("servers").getJSONObject(0).getString("detour"))
  assertEquals("proxy",JSONObject(generated).getJSONObject("dns").getJSONArray("servers").getJSONObject(0).getString("detour"))
 }
 @Test fun configured_private_leaf_never_proves_a_live_direct_selection_healthy() {
  val generated=sing.replace("\"final\":\"proxy\"","\"final\":\"choice\"").replace("\"outbounds\":[","\"outbounds\":[{\"type\":\"selector\",\"tag\":\"choice\",\"default\":\"proxy\",\"outbounds\":[\"proxy\",\"direct\"]},")
  val wired=RecoveryRuntimeConfig.wire(generated,"sing-box",18081,"private-token")!!
  assertEquals(setOf("proxy"),wired.endpoints.keys)
  assertNull(RecoveryRuntimeConfig.effective(generated,mapOf("choice" to "direct")))
 }
 @Test fun generated_many_profiles_use_fresh_members_and_a_private_inbound_for_each_leaf() {
  val raw="""{"inbounds":[{"type":"tun","tag":"tun"}],"outbounds":[{"type":"urltest","tag":"auto","outbounds":["one","two"]},{"type":"selector","tag":"proxy","default":"auto","outbounds":["auto","one","two"]},{"type":"vless","tag":"one"},{"type":"trojan","tag":"two"}],"dns":{"servers":[{"tag":"remote","type":"https","server":"1.1.1.1","detour":"proxy"}]},"route":{"final":"proxy"}}"""
  val wired=RecoveryRuntimeConfig.wire(raw,"sing-box",18081,"private-token")!!
  assertTrue(wired.dynamic);assertEquals(setOf("one","two"),wired.endpoints.keys)
  assertEquals("two",RecoveryRuntimeConfig.effective(raw,mapOf("proxy" to "auto","auto" to "two")))
  assertNull(RecoveryRuntimeConfig.effective(raw,mapOf("proxy" to "unknown")))
  val candidate=RecoveryRuntimeConfig.candidate(raw,"sing-box","two",mapOf("proxy" to "auto","auto" to "two"))
  val probe=ProbeConfig.singbox(JSONObject(candidate),"two",19081,"candidate-token")
  assertEquals("two",probe.getJSONObject("dns").getJSONArray("servers").getJSONObject(0).getString("detour"))
  assertEquals("auto",JSONObject(wired.config).getJSONArray("outbounds").getJSONObject(1).getString("default"))
 }
 @Test fun one_selected_profile_among_one_hundred_uses_only_one_optional_listener() {
  val root=JSONObject("""{"inbounds":[],"route":{"final":"proxy"}}""")
  val out=org.json.JSONArray();val members=org.json.JSONArray()
  for(i in 0 until 100){val tag="node-"+i;members.put(tag);out.put(JSONObject().put("type","vless").put("tag",tag))}
  out.put(JSONObject().put("type","selector").put("tag","proxy").put("outbounds",members).put("default","node-0"));root.put("outbounds",out)
  var allocated=0
  val wired=RecoveryRuntimeConfig.wire(root.toString(),"sing-box",18081,"private-token"){allocated++;19000+allocated}!!
  assertTrue(wired.dynamic);assertEquals(setOf("node-0"),wired.endpoints.keys);assertEquals(0,allocated)
  assertEquals(1,JSONObject(wired.config).getJSONArray("inbounds").length())
  assertEquals("node-99",RecoveryRuntimeConfig.effective(root.toString(),mapOf("proxy" to "node-99")))
  assertFalse(wired.endpoints.containsKey("node-99"))
 }
 @Test fun xray_routes_only_its_private_inbound_to_selected_proxy() {
  val raw="""{"inbounds":[{"tag":"socks","protocol":"socks"}],"outbounds":[{"tag":"proxy","protocol":"vless"},{"tag":"direct","protocol":"freedom"}],"routing":{"rules":[{"type":"field","domain":["local"],"outboundTag":"direct"}]}}"""
  val wired=RecoveryRuntimeConfig.wire(raw,"xray",18081,"private-token")!!;val json=JSONObject(wired.config)
  val inbound=json.getJSONArray("inbounds").getJSONObject(1)
  assertEquals("private-token",inbound.getJSONObject("settings").getJSONArray("accounts").getJSONObject(0).getString("pass"))
  val rule=json.getJSONObject("routing").getJSONArray("rules").getJSONObject(0)
  assertEquals(wired.tag,rule.getJSONArray("inboundTag").getString(0));assertEquals("proxy",rule.getString("outboundTag"))
 }
}
