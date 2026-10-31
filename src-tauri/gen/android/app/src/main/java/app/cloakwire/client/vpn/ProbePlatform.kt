package app.cloakwire.client.vpn
import android.net.*
import android.os.ParcelFileDescriptor
import io.nekohasekai.libbox.*
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicBoolean

/** Only this physical Network may carry diagnostic sockets, including DNS and UDP. */
internal object ProbePlatform {
 fun create(cm:ConnectivityManager,network:Network,cancelled:AtomicBoolean,expectedStamp:String):PlatformInterface {
  val props=cm.getLinkProperties(network)?:error("network_lost")
  val nic=java.net.NetworkInterface.getByName(props.interfaceName)?:error("network_lost")
  val dns=props.dnsServers.firstOrNull()?.hostAddress?:""
  return Proxy.newProxyInstance(PlatformInterface::class.java.classLoader,arrayOf(PlatformInterface::class.java)){proxy,method,args->
        when(method.name) {
          "hashCode"->System.identityHashCode(proxy)
          "equals"->proxy===args?.get(0)
          "toString"->"DiagnosticProbePlatform"
          "openTun"->{throw IllegalStateException("diagnostic_tun_forbidden")}
          "usePlatformAutoDetectInterfaceControl"->true
          "autoDetectInterfaceControl"->{
            check(!cancelled.get())
            check(stamp(cm,network)==expectedStamp){"network_lost"}
            val caps=cm.getNetworkCapabilities(network)?:error("network_lost")
            check(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)){"network_changed"}
            ParcelFileDescriptor.fromFd(args!![0] as Int).use { fd ->
              network.bindSocket(fd.fileDescriptor)

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

 }
 fun stamp(cm:ConnectivityManager,network:Network):String? {
  val props=cm.getLinkProperties(network)?:return null
  val caps=cm.getNetworkCapabilities(network)?:return null
  if(!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)||!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))return null
  return ProbeNetworkKey(network.networkHandle.toString(),props.interfaceName?:"",
   props.dnsServers.map{it.hostAddress?:""},props.linkAddresses.map{it.toString()},
   props.routes.map{it.toString()},props.mtu,
   caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
   caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)).revision()
 }
 fun choose(cm:ConnectivityManager):Network? {
  val physical=cm.allNetworks.filter{
   val caps=cm.getNetworkCapabilities(it)
   caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)==true &&
    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
  }
  return physical.firstOrNull{it==cm.activeNetwork}?:physical.singleOrNull()
 }
}
