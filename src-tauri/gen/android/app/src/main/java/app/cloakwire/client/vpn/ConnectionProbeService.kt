package app.cloakwire.client.vpn

import android.app.Service
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.*
import io.nekohasekai.libbox.*
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/** One disposable process owns all diagnostic Go globals, sockets, files and child processes. */
open class ConnectionProbeService:Service() {
 private val main=Handler(Looper.getMainLooper())
 private val cancelled=AtomicBoolean(false)
 private val begun=AtomicBoolean(false)
 private var reply:Messenger?=null
 private var death:IBinder.DeathRecipient?=null
 private var operation=""
 @Volatile private var stage="initial"
 @Volatile private var core:CommandServer?=null
 private val resources=ProbeResources()
 @Volatile private var socket:Socket?=null
 @Volatile private var worker:Thread?=null
 private var root:File?=null
 private val inbox=Messenger(Handler(Looper.getMainLooper()){m->
  if(m.sendingUid!=android.os.Process.myUid())return@Handler true
  if(m.what==2){finish(HealthOutcome.CANCELLED,null,null);return@Handler true}
  if(m.what!=1 || !begun.compareAndSet(false,true))return@Handler true
  operation=m.data.getString("operation").orEmpty();reply=m.replyTo
  death=IBinder.DeathRecipient{finish(HealthOutcome.CANCELLED,null,null)}
  try{reply!!.binder.linkToDeath(death!!,0)}catch(_:Exception){finish(HealthOutcome.CANCELLED,null,null);return@Handler true}
  val data=Bundle(m.data)
  main.postDelayed({finish(HealthOutcome.FAILED,HealthIssue.TIMEOUT,null)},data.getLong("remaining").coerceIn(1,ProbeState.DEADLINE_MS))
  worker=Thread({run(data)},"profile-probe").also{it.start()}
  true
 })
 override fun onCreate(){super.onCreate();main.postDelayed({finish(HealthOutcome.FAILED,HealthIssue.TIMEOUT,null)},ProbeState.DEADLINE_MS+ProbeState.CLEANUP_MS)}
 override fun onBind(intent:Intent):IBinder=inbox.binder
 override fun onUnbind(intent:Intent):Boolean{finish(HealthOutcome.CANCELLED,null,null);return false}
 override fun onDestroy(){finish(HealthOutcome.CANCELLED,null,null);super.onDestroy()}
 private fun finish(outcome:HealthOutcome,issue:HealthIssue?,latency:Long?) {
  if(!cancelled.compareAndSet(false,true))return
  runCatching{reply?.send(Message.obtain(null,1).apply{data=Bundle().apply{
   putString("operation",operation);putString("outcome",outcome.name);putString("issue",issue?.name);putLong("latency",latency?:-1)
  }})}
  worker?.interrupt()
  main.postDelayed({android.os.Process.killProcess(android.os.Process.myPid())},ProbeState.CLEANUP_MS)
  Thread({
   runCatching{socket?.close()}
   runCatching{resources.close()}
   runCatching{core?.closeService()};runCatching{core?.close()}
   root?.let{dir->runCatching{dir.deleteRecursively()}}
   runCatching{death?.let{reply?.binder?.unlinkToDeath(it,0)}}
   // The only PID ever killed is this dedicated service process.
   main.post{android.os.Process.killProcess(android.os.Process.myPid())}
  },"profile-probe-cleanup").start()
 }
 private fun port()=ServerSocket(0,1,InetAddress.getByName("127.0.0.1")).use{it.localPort}
 private fun run(data:Bundle){
  try{
   stage="input"
   val dir=File(cacheDir,"p-"+operation)
   check(operation.matches(Regex("[a-f0-9-]{36}")) && dir.mkdir())
   root=dir
   val path=File(data.getString("path")?:error("missing_config")).canonicalFile
   val parent=File(cacheDir,"profile-probe-input").canonicalFile
   check(path.parentFile==parent && path.name==operation+".json")
   val raw=try{check(path.length()<=4*1024*1024);path.readText()}finally{path.delete()}
   stage="config"
   val original=JSONObject(raw)
   val engine=data.getString("engine")?:"";check(engine=="singbox"||engine=="xray")
   val tag=ProbeConfig.target(original,engine,data.getString("tag").orEmpty())
   val network=Network.fromNetworkHandle(data.getLong("network"))
   val cm=getSystemService(ConnectivityManager::class.java)
   check(ProbePlatform.choose(cm)==network && ProbePlatform.stamp(cm,network)==data.getString("networkStamp")){"network_lost"}
   val httpPort=port();val password=UUID.randomUUID().toString()
   val dialPort=port();val dialPassword=UUID.randomUUID().toString()
   val conf=if(engine=="singbox")ProbeConfig.singbox(original,tag,httpPort,password)
    else ProbeConfig.dialer(dialPort,dialPassword)
   val xray=if(engine=="xray")ProbeConfig.xray(original,tag,httpPort,password,dialPort,dialPassword) else null
   if(cancelled.get())return
   stage="libbox_setup"
   Libbox.setup(SetupOptions().apply{
    basePath=File(dir,"b").apply{mkdirs()}.absolutePath
    workingPath=File(dir,"w").apply{mkdirs()}.absolutePath
    tempPath=File(dir,"t").apply{mkdirs()}.absolutePath
    commandServerSecret=UUID.randomUUID().toString();fixAndroidStack=true;logMaxLines=1;debug=false
   })
   stage="libbox_check"
   Libbox.checkConfig(conf.toString())
   val handler=object:CommandServerHandler{
    override fun serviceStop(){}
    override fun serviceReload(){}
    override fun getSystemProxyStatus()=SystemProxyStatus().apply{available=false;enabled=false}
    override fun setSystemProxyEnabled(enabled:Boolean){error("no_system_proxy")}
    override fun triggerNativeCrash(){error("no_crash")}
    override fun writeDebugMessage(message:String){}
    override fun connectSSHAgent()=-1
   }
   stage="libbox_start"
   val server=Libbox.newCommandServer(handler,ProbePlatform.create(cm,network,cancelled,data.getString("networkStamp")?:error("network_lost")));core=server
   if(cancelled.get())return
   server.start();server.startOrReloadService(conf.toString(),OverrideOptions().apply{autoRedirect=false})
   check(server.ready())
   var child:java.lang.Process?=null
   if(xray!=null){
    stage="xray_start"
    val children=File(cacheDir,"profile-probe-children")
    CoreProcessRecovery.reap(children)
    val childOwner=CoreProcessOwner(children)
    if(!resources.own(childOwner))return
    val binary=File(applicationInfo.nativeLibraryDir,XrayEngine.BINARY_NAME)
    val lease=childOwner.start(xray.toString()){file->
     ProcessBuilder(binary.absolutePath,"run","-c",file.absolutePath).redirectErrorStream(true).start()
    }
    CoreProcessRecovery.record(lease.configFile,binary.absolutePath)
    child=lease.process
    Thread({runCatching{lease.process.inputStream.use{input->val buffer=ByteArray(4096);while(input.read(buffer)>=0){}}}},"probe-drain").apply{isDaemon=true;start()}
   }
   stage="readiness"
   val readyUntil=SystemClock.elapsedRealtime()+2500
   while(!cancelled.get()){
    check(child==null||child.isAlive){"engine_unavailable"}
    if(runCatching{ProbeHttp.challenge(httpPort)}.getOrDefault(false))break
    check(SystemClock.elapsedRealtime()<readyUntil){"engine_unavailable"}
    Thread.sleep(40)
   }
   if(cancelled.get())return
   stage="https"
   val started=SystemClock.elapsedRealtime()
   var success=false
   for(fallback in listOf(false,true)){
    if(cancelled.get())return
    success=runCatching{ProbeHttp.request(httpPort,password,fallback){socket=it}}.getOrDefault(false)
    if(success)break
   }
   if(cancelled.get())return
   check(ProbePlatform.choose(cm)==network && ProbePlatform.stamp(cm,network)==data.getString("networkStamp")){"network_lost"}
   finish(if(success)HealthOutcome.HEALTHY else HealthOutcome.FAILED,
    if(success)null else HealthIssue.PROBE_TARGET_UNAVAILABLE,if(success)SystemClock.elapsedRealtime()-started else null)
  }catch(error:Throwable){
   if(app.cloakwire.client.BuildConfig.DEBUG)android.util.Log.w("ProfileProbe","failed stage="+stage+" type="+error.javaClass.simpleName+" flags="+listOf("unix","too long","invalid argument","permission denied","address already in use","no such file","bind","log","outbound","dns").filter{error.message?.contains(it,true)==true}.joinToString(","))
   if(!cancelled.get()){
    val issue=when{
     error is IllegalArgumentException->HealthIssue.UNSUPPORTED_PROBE
     error is SecurityException->HealthIssue.NETWORK_UNAVAILABLE
     error.message=="network_lost"->HealthIssue.NETWORK_UNAVAILABLE
     else->HealthIssue.ENGINE_UNAVAILABLE
    }
    finish(HealthOutcome.UNAVAILABLE,issue,null)
   }
  }
 }
}
