package app.cloakwire.client.vpn

import android.content.*
import android.net.*
import android.os.*
import app.tauri.plugin.JSObject
import java.io.File
import org.json.JSONObject

/** Main-process owner survives WebView subscriptions. A new job waits for the old process to die. */
internal object ProbeCoordinator {
 private val main=Handler(Looper.getMainLooper())
 private val state=ProbeState()
 private lateinit var app:Context
 private var network:Network?=null
 private var networkStamp:String?=null
 private var callback:ConnectivityManager.NetworkCallback?=null
 private var connection:ServiceConnection?=null
 private var remote:Messenger?=null
 private var boundId:String?=null
 private var pending:Bundle?=null
 private var input:File?=null
 private var contextRun="stopped"
 @Volatile var emitter:((JSObject)->Unit)?=null
 fun initialize(context:Context){app=context.applicationContext}
 fun snapshot():JSObject=JSObject().put("selected_profile",state.snapshot()?.toJson()?:JSONObject.NULL)
  .put("active_session",JSONObject.NULL) as JSObject
 private fun emit(){runCatching{emitter?.invoke(snapshot())}}
 private fun now()=SystemClock.elapsedRealtime()
 fun begin(source:ProfileSource):ConnectionHealth {
  check(::app.isInitialized)
  val health=state.begin(source,VpnEvents.currentRun(),now())
  main.post{
   if(state.snapshot()?.operationId!=health.operationId)return@post
   if(boundId!=null && boundId!=health.operationId)sendCancel()
   contextRun=VpnEvents.currentRun()
   observeNetwork()
   val selected=ProbePlatform.choose(app.getSystemService(ConnectivityManager::class.java))
   network=selected
   networkStamp=selected?.let{ProbePlatform.stamp(app.getSystemService(ConnectivityManager::class.java),it)}
   if(selected==null || networkStamp==null)state.finish(health.operationId,HealthOutcome.UNAVAILABLE,HealthIssue.NETWORK_UNAVAILABLE,null,now())
   else state.network(health.operationId,networkStamp!!)
   emit()
   main.postDelayed({
    if(state.snapshot()?.operationId==health.operationId && state.snapshot()?.outcome==HealthOutcome.CHECKING){
     state.finish(health.operationId,HealthOutcome.FAILED,HealthIssue.TIMEOUT,null,now());discardPending();sendCancel();emit()
    }
   },state.remaining(health.operationId,now()))
  }
  return health
 }
 fun submit(id:String,source:ProfileSource,engine:String,config:String,tag:String){
  require(config.length<=4*1024*1024 && engine in setOf("singbox","xray")){"unsupported_probe"}
  check(state.matches(id,source)){"profile_check_cancelled"}
  main.post{
   if(!state.matches(id,source))return@post
   if(contextRun!=VpnEvents.currentRun()){invalidate();return@post}
   if(boundId==id||pending?.getString("operation")==id)return@post
   try{
    discardPending()
    val directory=File(app.cacheDir,"profile-probe-input").apply{check(isDirectory||mkdirs())}
    val file=File(directory,id+".json");file.writeText(config);input=file
    pending=Bundle().apply{putString("operation",id);putString("engine",engine);putString("tag",tag);putString("path",file.absolutePath)}
    startPending()
   }catch(_:Exception){
    state.finish(id,HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE,null,now());discardPending();emit()
   }
  }
 }
 fun fail(id:String,issue:HealthIssue){main.post{
  if(state.snapshot()?.operationId!=id)return@post
  state.finish(id,HealthOutcome.UNAVAILABLE,issue,null,now());discardPending();sendCancel();emit()
 }}
 fun cancel(id:String){state.cancel(id);main.post{
  if(pending?.getString("operation")==id)discardPending()
  if(boundId==id)sendCancel()
  emit()
 }}
 fun invalidate(){val previous=state.snapshot()?.operationId;state.invalidate();main.post{
  if(pending?.getString("operation")==previous)discardPending()
  if(boundId==previous)sendCancel()
  emit()
 }}
 private fun discardPending(){pending=null;input?.delete();input=null}
 private fun sendCancel(){runCatching{remote?.send(Message.obtain(null,2))}}
 private fun observeNetwork(){
  if(callback!=null)return
  val cm=app.getSystemService(ConnectivityManager::class.java)
  val cb=object:ConnectivityManager.NetworkCallback(){
   private fun changed(){main.post{
    val previous=network?:return@post
    if(ProbePlatform.choose(cm)!=previous || ProbePlatform.stamp(cm,previous)!=networkStamp){network=null;networkStamp=null;invalidate()}
   }}
   override fun onLost(value:Network)=changed()
   override fun onAvailable(value:Network)=changed()
   override fun onCapabilitiesChanged(value:Network,caps:NetworkCapabilities)=changed()
   override fun onLinkPropertiesChanged(value:Network,props:LinkProperties)=changed()
  }
  cm.registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(),cb)
  callback=cb
 }
 private fun startPending(){
  if(connection!=null)return
  val data=pending?:return
  val id=data.getString("operation")?:return
  if(state.snapshot()?.operationId!=id || state.snapshot()?.outcome!=HealthOutcome.CHECKING){discardPending();return}
  val net=network
  if(net==null || ProbePlatform.choose(app.getSystemService(ConnectivityManager::class.java))!=net){
   state.finish(id,HealthOutcome.UNAVAILABLE,HealthIssue.NETWORK_UNAVAILABLE,null,now());discardPending();emit();return
  }
  val reply=Messenger(Handler(Looper.getMainLooper()){message->
   if(message.sendingUid!=android.os.Process.myUid() || message.data.getString("operation")!=id)return@Handler true
   if(state.snapshot()?.operationId==id){
    val outcome=runCatching{HealthOutcome.valueOf(message.data.getString("outcome")!!)}.getOrDefault(HealthOutcome.UNAVAILABLE)
    val issue=runCatching{HealthIssue.valueOf(message.data.getString("issue")!!)}.getOrNull()
    val latency=message.data.getLong("latency",-1).takeIf{it>=0}
    state.finish(id,outcome,issue,latency,now());emit()
   }
   true
  })
  val conn=object:ServiceConnection{
   override fun onServiceConnected(name:ComponentName,binder:IBinder){
    if(connection!==this)return
    remote=Messenger(binder)
    if(state.snapshot()?.operationId!=id || state.snapshot()?.outcome!=HealthOutcome.CHECKING){sendCancel();return}
    data.putLong("network",net.networkHandle);data.putString("networkStamp",networkStamp);data.putLong("remaining",state.remaining(id,now()))
    try{remote!!.send(Message.obtain(null,1).apply{this.data=data;replyTo=reply});pending=null}
    catch(_:Exception){state.finish(id,HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE,null,now());sendCancel();emit()}
   }
   private fun disconnected(){
    if(connection!==this)return
    runCatching{app.unbindService(this)}
    connection=null;remote=null;boundId=null
    if(state.snapshot()?.operationId==id && state.snapshot()?.outcome==HealthOutcome.CHECKING){
     state.finish(id,HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE,null,now());emit()
    }
    if(input?.name==id+".json"){input?.delete();input=null}
    startPending()
   }
   override fun onServiceDisconnected(name:ComponentName)=disconnected()
   override fun onBindingDied(name:ComponentName)=disconnected()
   override fun onNullBinding(name:ComponentName)=disconnected()
  }
  connection=conn;boundId=id
  if(!app.bindService(Intent(app,ConnectionProbeService::class.java),conn,Context.BIND_AUTO_CREATE)){
   connection=null;boundId=null;state.finish(id,HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE,null,now());discardPending();emit()
  }
 }
}
