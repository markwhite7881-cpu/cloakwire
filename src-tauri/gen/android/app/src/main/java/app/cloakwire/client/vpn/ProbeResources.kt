package app.cloakwire.client.vpn
import java.io.Closeable
import java.security.MessageDigest
import org.json.JSONArray

/** Cancellation retires publication itself, not merely resources already visible to cleanup. */
internal class ProbeResources:Closeable {
 private var retired=false
 private val values=mutableListOf<Closeable>()
 fun own(value:Closeable):Boolean {
  synchronized(this){if(!retired){values.add(value);return true}}
  value.close();return false
 }
 override fun close(){
  val owned=synchronized(this){retired=true;values.toList().asReversed().also{values.clear()}}
  var failure:Exception?=null
  owned.forEach{try{it.close()}catch(error:Exception){if(failure==null)failure=error}}
  failure?.let{throw it}
 }
}
internal data class ProbeNetworkKey(
 val handle:String,val device:String,val dns:List<String>,val addresses:List<String>,
 val routes:List<String>,val mtu:Int,val validated:Boolean,val captive:Boolean,
){
 fun revision():String {
  val value=JSONArray().put(handle).put(device).put(JSONArray(dns.sorted()))
   .put(JSONArray(addresses.sorted())).put(JSONArray(routes.sorted())).put(mtu).put(validated).put(captive)
  return MessageDigest.getInstance("SHA-256").digest(value.toString().toByteArray(Charsets.UTF_8))
   .joinToString(""){"%02x".format(it)}
 }
}
