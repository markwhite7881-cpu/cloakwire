package app.cloakwire.client.vpn

import android.app.Service
import android.content.Intent
import android.net.*
import android.os.*
import io.nekohasekai.libbox.*
import java.io.File
import java.lang.reflect.Proxy
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

/** Debug-only real-AAR feasibility test. Never loads a user profile or calls VpnService. */
class DiagnosticIsolationService:Service() {
  private val main=Handler(Looper.getMainLooper())
  private val cancelled=AtomicBoolean(false)
  private val begun=AtomicBoolean(false)
  private val boundSockets=AtomicInteger();private val tun=AtomicInteger()
  private var reply:Messenger?=null
  private var death:IBinder.DeathRecipient?=null
  @Volatile private var server:CommandServer?=null
  @Volatile private var client:CommandClient?=null
  @Volatile private var request:java.net.HttpURLConnection?=null
  @Volatile private var stage="initial"
  private var root:File?=null
  private val inbox=Messenger(Handler(Looper.getMainLooper()) { message ->
    if(message.sendingUid!=android.os.Process.myUid())return@Handler true
    when(message.data.getString("mode")){
      "cancel" -> {reply=message.replyTo;close("cancelled")}
      "crash" -> android.os.Process.killProcess(android.os.Process.myPid())
      else -> if(begun.compareAndSet(false,true)) {
        reply=message.replyTo
        death=IBinder.DeathRecipient {close(null)}
        reply?.binder?.linkToDeath(death!!,0)
        val mode=message.data.getString("mode")?:"hold"
        main.postDelayed({close("timeout")},20_000)
        Thread({run(mode)},"isolated-libbox").start()
      }
    }
    true
  })
  override fun onBind(intent:Intent):IBinder=inbox.binder
  override fun onUnbind(intent:Intent):Boolean {close(null);return false}
  override fun onDestroy(){close(null);super.onDestroy()}

  private fun reply(state:String,fields:JSONObject=JSONObject()) {
    fields.put("state",state).put("pid",android.os.Process.myPid()).put("boundSockets",boundSockets.get())
    runCatching {reply?.send(Message.obtain(null,1).apply{data=Bundle().apply{putString("result",fields.toString())}})}
  }
  private fun close(state:String?) {
    if(!cancelled.compareAndSet(false,true))return
    main.postDelayed({android.os.Process.killProcess(android.os.Process.myPid())},1500)
    Thread({
      runCatching {request?.disconnect()}
      runCatching {client?.disconnect()}
      runCatching {server?.closeService()}
      runCatching {server?.close()}
      if(state!=null)reply(state)
      // All Go threads and sockets belong to this dedicated process; no app-wide kill.
      main.postDelayed({android.os.Process.killProcess(android.os.Process.myPid())},100)
    },"isolation-close").start()
  }
  private fun run(mode:String) {
    try {
      stage="physical_network"
      val cm=getSystemService(ConnectivityManager::class.java)
      val network=cm.allNetworks.firstOrNull {
        val caps=cm.getNetworkCapabilities(it)
        caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)==true &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) &&
          !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
      } ?: error("no_physical_network")
      val props=cm.getLinkProperties(network)?:error("no_link_properties")
      val nic=java.net.NetworkInterface.getByName(props.interfaceName)?:error("no_interface")
      val dns=props.dnsServers.firstOrNull()?.hostAddress?.substringBefore('%')?:error("no_dns")
      val tag="isolation-"+UUID.randomUUID()
      val dir=File(cacheDir,tag).apply {check(mkdirs())}
      root=dir
      stage="setup"
      Libbox.setup(SetupOptions().apply {
        basePath=File(dir,"base").apply{mkdirs()}.absolutePath
        workingPath=File(dir,"work").apply{mkdirs()}.absolutePath
        tempPath=File(dir,"temp").apply{mkdirs()}.absolutePath
        commandServerSecret=UUID.randomUUID().toString()
        fixAndroidStack=true;logMaxLines=10;debug=false
      })
      val platform=Proxy.newProxyInstance(PlatformInterface::class.java.classLoader,arrayOf(PlatformInterface::class.java)){proxy,method,args->
        when(method.name) {
          "hashCode"->System.identityHashCode(proxy)
          "equals"->proxy===args?.get(0)
          "toString"->"DiagnosticProbePlatform"
          "openTun"->{tun.incrementAndGet();throw IllegalStateException("diagnostic_tun_forbidden")}
          "usePlatformAutoDetectInterfaceControl"->true
          "autoDetectInterfaceControl"->{
            check(!cancelled.get()){"cancelled"}
            val caps=cm.getNetworkCapabilities(network)?:error("network_lost")
            check(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)){"network_changed"}
            ParcelFileDescriptor.fromFd(args!![0] as Int).use { fd ->
              network.bindSocket(fd.fileDescriptor)
              boundSockets.incrementAndGet()
            };null
          }
          "startDefaultInterfaceMonitor"->{
            (args!![0] as InterfaceUpdateListener).updateDefaultInterface(nic.name,nic.index,false,false);null
          }
          "getInterfaces"->{
            val item=io.nekohasekai.libbox.NetworkInterface().apply {
              name=nic.name;index=nic.index;setMTU(nic.mtu);flags=1
              type=Libbox.InterfaceTypeWIFI
              addresses=SimpleStringIterator(nic.interfaceAddresses.map { "${it.address.hostAddress?.substringBefore('%')}/${it.networkPrefixLength}" })
              setDNSServer(SimpleStringIterator(listOf(dns)))
            }
            object:NetworkInterfaceIterator {var read=false;override fun hasNext()=!read;override fun next():io.nekohasekai.libbox.NetworkInterface {read=true;return item}}
          }
          "localDNSTransport"->object:LocalDNSTransport {
            override fun raw()=false
            override fun exchange(ctx:ExchangeContext,bytes:ByteArray){throw IllegalStateException("raw_dns_unsupported")}
            override fun lookup(ctx:ExchangeContext,net:String,name:String) {
              check(!cancelled.get())
              val addresses=network.getAllByName(name).filter{net!="ip4"||it is java.net.Inet4Address}.filter{net!="ip6"||it is java.net.Inet6Address}
              check(!cancelled.get())
              ctx.success(addresses.joinToString("\n"){it.hostAddress?:""})
            }
          }
          "readWIFIState"->null
          "clearDNSCache","closeDefaultInterfaceMonitor","closeNeighborMonitor","sendNotification","registerMyInterface"->null
          "includeAllNetworks","underNetworkExtension","useProcFS","usePlatformBridge","usePlatformShell"->false
          "tailscaleHostname"->""
          else->throw UnsupportedOperationException("unsupported_probe_platform")
        }
      } as PlatformInterface
      val handler=object:CommandServerHandler {
        override fun serviceStop(){}
        override fun serviceReload(){}
        override fun getSystemProxyStatus()=SystemProxyStatus().apply{available=false;enabled=false}
        override fun setSystemProxyEnabled(enabled:Boolean){throw IllegalStateException("no_system_proxy")}
        override fun triggerNativeCrash(){throw IllegalStateException("no_crash")}
        override fun writeDebugMessage(message:String){}
        override fun connectSSHAgent()=-1
      }
      stage="core_start"
      val port=ServerSocket(0,1,java.net.InetAddress.getByName("127.0.0.1")).use{it.localPort}
      val inbound=if(mode=="tun")"""{"type":"tun","address":["172.30.255.1/30"]}"""
        else """{"type":"mixed","listen":"127.0.0.1","listen_port":$port}"""
      val config="""{"log":{"disabled":true},"dns":{"servers":[{"type":"udp","tag":"wire","server":"$dns"}]},"inbounds":[$inbound],"outbounds":[{"type":"direct","tag":"$tag"}],"route":{"auto_detect_interface":true,"default_domain_resolver":"wire","final":"$tag"}}"""
      Libbox.checkConfig(config)
      val core=Libbox.newCommandServer(handler,platform);server=core
      if(cancelled.get())return
      core.start()
      try {core.startOrReloadService(config,OverrideOptions().apply{autoRedirect=false})}
      catch(e:Exception) {
        if(mode=="tun"&&tun.get()>0){reply("tun_rejected",JSONObject().put("tunRejected",true));close(null);return}
        throw e
      }
      check(core.ready())
      stage="command_channel"
      val clientHandler=Proxy.newProxyInstance(CommandClientHandler::class.java.classLoader,arrayOf(CommandClientHandler::class.java)){proxy,method,args->
        when(method.name){"hashCode"->System.identityHashCode(proxy);"equals"->proxy===args?.get(0);"toString"->"DiagnosticClientHandler";else->null}
      } as CommandClientHandler
      val command=Libbox.newCommandClient(clientHandler,CommandClientOptions());client=command;command.connect()
      val commandConnected=JSONObject(command.runningConfig.content()).getJSONArray("outbounds").getJSONObject(0).getString("tag")==tag
      stage="dns"
      val dnsResolved=network.getAllByName("www.gstatic.com").isNotEmpty()
      stage="udp"
      val beforeUdp=boundSockets.get()
      val udpRelay=udpDns(port,dns)
      check(udpRelay && boundSockets.get()>beforeUdp)
      stage="https"
      val connection=URL("https://www.gstatic.com/generate_204").openConnection(java.net.Proxy(java.net.Proxy.Type.HTTP,InetSocketAddress("127.0.0.1",port))) as java.net.HttpURLConnection
      request=connection;connection.connectTimeout=5000;connection.readTimeout=5000;connection.instanceFollowRedirects=false
      val ok=try{connection.responseCode==204}finally{connection.disconnect();request=null}
      check(ok&&boundSockets.get()>=2&&commandConnected)
      if(!cancelled.get())reply("ready",JSONObject().put("https204",ok).put("dnsResolved",dnsResolved).put("udpRelay",udpRelay).put("commandConnected",commandConnected).put("privatePaths",dir.canonicalPath.startsWith(cacheDir.canonicalPath+File.separator)))
    } catch(e:Throwable) {
      if(!cancelled.get())reply("failed",JSONObject().put("stage",stage).put("reason",e.javaClass.simpleName))
      close(null)
    }
  }

  /** Explicit SOCKS5 UDP ASSOCIATE: literal DNS endpoint, fixed non-private query. */
  private fun udpDns(port:Int,dns:String):Boolean {
    java.net.Socket("127.0.0.1",port).use { control ->
      control.soTimeout=5000
      val input=java.io.DataInputStream(control.getInputStream());val output=control.getOutputStream()
      output.write(byteArrayOf(5,1,0));output.flush()
      check(input.readUnsignedByte()==5 && input.readUnsignedByte()==0)
      output.write(byteArrayOf(5,3,0,1,0,0,0,0,0,0));output.flush()
      check(input.readUnsignedByte()==5 && input.readUnsignedByte()==0);input.readUnsignedByte()
      val size=when(input.readUnsignedByte()){1->4;4->16;else->error("udp_address")}
      val address=ByteArray(size);input.readFully(address);val relayPort=input.readUnsignedShort()
      val endpoint=java.net.InetAddress.getByName(dns).address
      val query=byteArrayOf(0x43,0x57,1,0,0,1,0,0,0,0,0,0,3,119,119,119,7,103,115,116,97,116,105,99,3,99,111,109,0,0,1,0,1)
      val header=byteArrayOf(0,0,0,(if(endpoint.size==4)1 else 4).toByte())+endpoint+byteArrayOf(0,53)
      java.net.DatagramSocket(java.net.InetSocketAddress("127.0.0.1",0)).use { socket ->
        socket.soTimeout=5000
        val packet=header+query
        socket.send(java.net.DatagramPacket(packet,packet.size,java.net.InetAddress.getByName("127.0.0.1"),relayPort))
        val response=java.net.DatagramPacket(ByteArray(4096),4096);socket.receive(response)
        val bytes=response.data
        val offset=when(bytes[3].toInt()){1->10;4->22;else->return false}
        return response.length>=offset+12 && bytes[2].toInt()==0 && bytes[offset]==0x43.toByte() &&
          bytes[offset+1]==0x57.toByte() && (bytes[offset+2].toInt() and 0x80)!=0 &&
          (bytes[offset+3].toInt() and 15)==0
      }
    }
  }
}
