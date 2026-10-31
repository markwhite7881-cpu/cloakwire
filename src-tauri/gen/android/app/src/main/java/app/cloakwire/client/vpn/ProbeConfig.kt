package app.cloakwire.client.vpn
import org.json.JSONArray
import org.json.JSONObject

/** Private runtime copies. Unsupported provider dependencies are never guessed. */
internal object ProbeConfig {
 private val singKinds=setOf("vless","vmess","trojan","shadowsocks","hysteria2","tuic","anytls","socks","http")
 private val xrayKinds=setOf("vless","vmess","trojan","shadowsocks","socks","http")
 private fun requireSafe(ok:Boolean){require(ok){"unsupported_probe"}}
 private fun objects(array:JSONArray)= (0 until array.length()).map{array.getJSONObject(it)}
 private fun kind(engine:String)=if(engine=="xray")"protocol" else "type"
 fun target(config:JSONObject,engine:String,requested:String):String {
  val out=objects(config.getJSONArray("outbounds"));val key=kind(engine)
  val tags=out.map{it.getString("tag")};requireSafe(tags.distinct().size==tags.size)
  val candidates=out.filter{it.optString(key) in if(engine=="xray")xrayKinds else singKinds}
   .filter{it.optString("tag")!="protected"}
  if(requested.isNotEmpty()){
   requireSafe(candidates.any{it.optString("tag")==requested});return requested
  }
  requireSafe(candidates.size==1);return candidates.single().getString("tag")
 }
 private fun rejectKeys(value:Any?,keys:Set<String>) {
  when(value){
   is JSONObject -> value.keys().forEach { key -> requireSafe(key !in keys);rejectKeys(value.opt(key),keys) }
   is JSONArray -> (0 until value.length()).forEach{rejectKeys(value.opt(it),keys)}
  }
 }
 fun singbox(original:JSONObject,tag:String,port:Int,password:String):JSONObject {
  requireSafe(port in 1..65535 && password.isNotEmpty())
  target(original,"singbox",tag)
  requireSafe(!original.has("services") && !original.has("endpoints") && !original.has("ntp"))
  val copy=JSONObject(original.toString())
  val list=objects(copy.getJSONArray("outbounds"))
  val keep=linkedSetOf<String>();val visiting=mutableSetOf<String>()
  fun visit(name:String) {
   if(name in keep)return
   requireSafe(visiting.add(name))
   val item=list.singleOrNull{it.optString("tag")==name}?:throw IllegalArgumentException("unsupported_probe")
   requireSafe(item.optString("type") in singKinds || item.optString("type")=="direct")
   rejectKeys(item,setOf("bind_interface","inet4_bind_address","inet6_bind_address","routing_mark","netns","network_strategy","network_type","fallback_network_type","certificate_path","key_path","ech","dialer_proxy"))
   val detour=item.optString("detour")
   if(detour.isNotEmpty())visit(detour)
   visiting.remove(name);keep.add(name)
  }
  visit(tag)
  val dns=copy.optJSONObject("dns")
  if(dns!=null) {
   rejectKeys(dns,setOf("rule_set","rule_set_ip_cidr_accept_empty","bind_interface","inet4_bind_address","inet6_bind_address","routing_mark","netns","certificate_path"))
   objects(dns.getJSONArray("servers")).forEach {
    requireSafe(it.optString("type") in setOf("local","udp","tcp","tls","https","quic"))
    if(it.optString("detour").isNotEmpty())visit(it.getString("detour"))
   }
  }
  val route=JSONObject().put("final",tag).put("auto_detect_interface",true)
  copy.optJSONObject("route")?.opt("default_domain_resolver")?.let{route.put("default_domain_resolver",it)}
  return JSONObject().put("log",JSONObject().put("disabled",true))
   .put("outbounds",JSONArray(list.filter{it.optString("tag") in keep}))
   .put("inbounds",JSONArray().put(JSONObject().put("type","http").put("tag","cw-probe")
    .put("listen","127.0.0.1").put("listen_port",port)
    .put("users",JSONArray().put(JSONObject().put("username","cw").put("password",password)))))
   .put("route",route).also{if(dns!=null)it.put("dns",dns)}
 }
 fun xray(original:JSONObject,tag:String,port:Int,password:String,dialPort:Int,dialPassword:String):JSONObject {
  target(original,"xray",tag)
  requireSafe(original.optJSONObject("dns")==null && !original.has("fakedns") && !original.has("observatory") && !original.has("burstObservatory"))
  val source=objects(original.getJSONArray("outbounds")).single{it.optString("tag")==tag}
  val proxy=JSONObject(source.toString())
  // Unproven chains/implicit transport DNS must not escape the bound dialer.
  requireSafe(!proxy.has("proxySettings") && !proxy.has("sendThrough"))
  val stream=proxy.optJSONObject("streamSettings")?:JSONObject()
  requireSafe(stream.optString("network","tcp") in setOf("tcp","raw","ws","httpupgrade"))
  requireSafe(!stream.has("sockopt") || stream.getJSONObject("sockopt").let {
   it.length()==0 || (it.length()==1 && it.optString("dialerProxy")=="protected")
  })
  rejectKeys(stream,setOf("echConfigList","echForceQuery","certificateFile","keyFile","ech","downloadSettings"))
  stream.put("sockopt",JSONObject().put("dialerProxy","cw-probe-dialer"))
  proxy.put("streamSettings",stream)
  val dialer=JSONObject().put("protocol","socks").put("tag","cw-probe-dialer")
   .put("settings",JSONObject().put("servers",JSONArray().put(JSONObject().put("address","127.0.0.1").put("port",dialPort)
    .put("users",JSONArray().put(JSONObject().put("user","cw").put("pass",dialPassword))))))
  return JSONObject().put("log",JSONObject().put("loglevel","none"))
   .put("inbounds",JSONArray().put(JSONObject().put("protocol","http").put("listen","127.0.0.1").put("port",port)
    .put("settings",JSONObject().put("accounts",JSONArray().put(JSONObject().put("user","cw").put("pass",password))))))
   .put("outbounds",JSONArray().put(proxy).put(dialer))
   .put("routing",JSONObject().put("domainStrategy","AsIs"))
 }
 fun dialer(port:Int,password:String):JSONObject=JSONObject("""{"log":{"disabled":true},"dns":{"servers":[{"tag":"local","type":"local"}]},"route":{"auto_detect_interface":true,"default_domain_resolver":"local","final":"wire"},"outbounds":[{"tag":"wire","type":"direct"}]}""")
  .put("inbounds",JSONArray().put(JSONObject().put("type","socks").put("listen","127.0.0.1").put("listen_port",port)
   .put("users",JSONArray().put(JSONObject().put("username","cw").put("password",password)))))
}
