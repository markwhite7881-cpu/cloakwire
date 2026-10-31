package app.cloakwire.client.vpn
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Runtime-only authenticated inbounds never match normal application traffic. */
internal object RecoveryRuntimeConfig {
 data class Endpoint(val tag:String,val port:Int,val password:String)
 data class Wired(val config:String,val tag:String,val port:Int,val password:String,val outbound:String,val dynamic:Boolean=false,val endpoints:Map<String,Endpoint> = emptyMap())
 private fun entries(root:JSONObject):Map<String,JSONObject> {
  val array=root.getJSONArray("outbounds")
  val values=(0 until array.length()).map{array.getJSONObject(it)}
  return values.associateBy{it.getString("tag")}.also{require(it.size==values.size)}
 }
 private fun configuredCandidate(root:JSONObject,start:String):String?=runCatching {
  val all=entries(root);val visited=mutableSetOf<String>();var tag=start
  while(true) {
   require(visited.add(tag) && visited.size<=16)
   val item=all[tag]?:error("unsupported_probe")
   if(item.optString("type")=="urltest")return@runCatching leaf(root,tag,null)
   if(item.optString("type")!="selector")return@runCatching ProbeConfig.target(root,"singbox",tag)
   val selected=item.getString("default");val members=item.getJSONArray("outbounds")
   require((0 until members.length()).any{members.getString(it)==selected});tag=selected
  }
  @Suppress("UNREACHABLE_CODE") error("unsupported_probe")
 }.getOrNull()
 private fun leaf(root:JSONObject,start:String,selections:Map<String,String>?):String {
  val all=entries(root)
  val visited=mutableSetOf<String>()
  fun visit(tag:String):Set<String> {
   require(visited.add(tag) && visited.size<=16)
   try {
    val entry=all[tag]?:error("unsupported_probe")
    if(entry.optString("type") !in setOf("selector","urltest"))return setOf(tag)
    val array=entry.getJSONArray("outbounds");require(array.length()>0)
    val members=(0 until array.length()).map{array.getString(it)}
    val selected=selections?.get(tag)
    if(selections!=null){require(selected!=null && selected in members);return visit(selected!!)}
    return members.flatMap{visit(it)}.toSet()
   }finally{visited.remove(tag)}
  }
  return visit(start).single()
 }
 fun effective(config:String,selections:Map<String,String>):String?=runCatching {
  val root=JSONObject(config)
  val tag=leaf(root,root.getJSONObject("route").getString("final"),selections)
  ProbeConfig.target(root,"singbox",tag)
 }.getOrNull()
 fun candidate(config:String,engine:String,tag:String,selections:Map<String,String> = emptyMap()):String {
  if(engine=="xray")return config
  val root=JSONObject(config)
  val selected=selections.takeIf{it.isNotEmpty()}
  require(leaf(root,root.getJSONObject("route").getString("final"),selected)==tag)
  val outbounds=root.getJSONArray("outbounds")
  for(i in 0 until outbounds.length()) {
   val outbound=outbounds.getJSONObject(i)
   if(outbound.has("detour"))outbound.put("detour",leaf(root,outbound.getString("detour"),selected))
  }
  val servers=root.optJSONObject("dns")?.optJSONArray("servers")
  if(servers!=null)for(i in 0 until servers.length()) {
   val server=servers.getJSONObject(i)
   if(server.has("detour"))server.put("detour",leaf(root,server.getString("detour"),selected))
  }
  return root.toString()
 }
 fun wire(config:String,engine:String,port:Int,password:String,allocatePort:(()->Int)?=null):Wired?=runCatching {
  require(port in 1..65535 && password.isNotBlank())
  val root=JSONObject(config);val xray=engine=="xray"
  val all=entries(root)
  val routeName=if(xray)"routing" else "route"
  val route=root.optJSONObject(routeName)?:JSONObject().also{root.put(routeName,it)}
  val final=if(xray)ProbeConfig.target(root,"xray","") else route.getString("final")
  val fixed=if(xray)final else runCatching{leaf(root,final,null)}.getOrNull()
  if(xray){require(!route.has("balancers"));require(root.getJSONArray("outbounds").getJSONObject(0).optString("tag")==final)}
  // A configured default selects optional wiring only. Every dynamic check still needs
  // a fresh native witness proving that this exact leaf is currently effective.
  val configured=if(xray || fixed!=null)null else configuredCandidate(root,final)
  val targets=if(fixed!=null)listOf(ProbeConfig.target(root,if(xray)"xray" else "singbox",fixed)) else if(configured!=null)listOf(configured) else {
   // Validate every reachable leaf; unknown groups or direct choices are never guessed.
   val visited=mutableSetOf<String>();val leaves=linkedSetOf<String>()
   fun visit(tag:String,path:Set<String>) {
    require(tag !in path && path.size<16)
    if(!visited.add(tag))return
    val outbound=all[tag]?:error("unsupported_probe")
    if(outbound.optString("type") in setOf("selector","urltest")) {
     val members=outbound.getJSONArray("outbounds");require(members.length()>0)
     for(i in 0 until members.length())visit(members.getString(i),path+tag)
    }else leaves.add(ProbeConfig.target(root,"singbox",tag))
   }
   visit(final,emptySet());require(leaves.size in 1..8);leaves.toList()
  }
  val inbounds=root.optJSONArray("inbounds")?:JSONArray().also{root.put("inbounds",it)}
  val previous=route.optJSONArray("rules")?:JSONArray()
  val rules=JSONArray();val endpoints=linkedMapOf<String,Endpoint>();val used=mutableSetOf<Int>()
  targets.forEachIndexed{index,target->
   val listenPort=if(index==0)port else allocatePort?.invoke()?:port+index
   require(listenPort in 1..65535 && used.add(listenPort))
   val tag="cw-active-"+UUID.randomUUID().toString()
   endpoints[target]=Endpoint(tag,listenPort,password)
   val inbound=JSONObject().put("tag",tag).put("listen","127.0.0.1")
   val rule=JSONObject()
   if(xray) {
    inbound.put("protocol","http").put("port",listenPort).put("settings",JSONObject().put("accounts",JSONArray().put(JSONObject().put("user","cw").put("pass",password))))
    rule.put("type","field").put("inboundTag",JSONArray().put(tag)).put("outboundTag",target)
   }else {
    inbound.put("type","http").put("listen_port",listenPort).put("users",JSONArray().put(JSONObject().put("username","cw").put("password",password)))
    rule.put("inbound",JSONArray().put(tag)).put("action","route").put("outbound",target)
   }
   inbounds.put(inbound);rules.put(rule)
  }
  for(i in 0 until previous.length())rules.put(previous.get(i));route.put("rules",rules)
  val first=endpoints.values.first()
  Wired(root.toString(),first.tag,first.port,first.password,fixed?:final,fixed==null,endpoints)
 }.getOrNull()
}
