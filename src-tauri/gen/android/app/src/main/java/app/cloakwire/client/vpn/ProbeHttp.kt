package app.cloakwire.client.vpn

import java.io.BufferedInputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** Fixed HTTPS targets; no redirects, global authenticator, proxy inheritance or stored response. */
internal object ProbeHttp {
 fun accepts(fallback:Boolean,code:Int,body:String):Boolean {
  if(!fallback)return code==204
  if(code!=200 || body.toByteArray(Charsets.UTF_8).size>4096)return false
  val fields=body.lineSequence().mapNotNull{line->val at=line.indexOf('=');if(at>0)line.substring(0,at) to line.substring(at+1) else null}.toMap()
  return fields["h"]=="www.cloudflare.com" && !fields["ip"].isNullOrBlank() && fields["tls"]?.startsWith("TLS")==true
 }
 private fun headers(input:BufferedInputStream):Pair<Int,Map<String,String>> {
  val bytes=ArrayList<Byte>();var tail=""
  while(bytes.size<8192){
   val byte=input.read();check(byte>=0){"probe_headers"}
   bytes.add(byte.toByte());tail=(tail+byte.toChar()).takeLast(4)
   if(tail=="\r\n\r\n")break
  }
  check(tail=="\r\n\r\n"){"probe_headers"}
  val lines=bytes.toByteArray().toString(Charsets.US_ASCII).split("\r\n")
  val status=Regex("""HTTP/1\.[01] ([0-9]{3})(?: .*|)""").matchEntire(lines.first())?.groupValues?.get(1)?.toInt()?:error("probe_headers")
  return status to lines.drop(1).mapNotNull{line->val colon=line.indexOf(':');if(colon>0)line.substring(0,colon).lowercase() to line.substring(colon+1).trim() else null}.toMap()
 }
 fun challenge(port:Int):Boolean=Socket().use { socket ->
  socket.connect(InetSocketAddress("127.0.0.1",port),200);socket.soTimeout=300
  socket.getOutputStream().write("CONNECT www.gstatic.com:443 HTTP/1.1\r\nHost: www.gstatic.com:443\r\n\r\n".toByteArray(Charsets.US_ASCII))
  headers(BufferedInputStream(socket.getInputStream())).first==407
 }
 fun request(port:Int,password:String,fallback:Boolean,onSocket:(Socket?)->Unit):Boolean {
  val host=if(fallback)"www.cloudflare.com" else "www.gstatic.com"
  val path=if(fallback)"/cdn-cgi/trace" else "/generate_204"
  val socket=Socket();onSocket(socket)
  try{
   socket.connect(InetSocketAddress("127.0.0.1",port),600);socket.soTimeout=3500
   // android.util.Base64 is unavailable in pure JVM tests; java.util.Base64 requires API26,
   // so the runtime uses the Android encoder instead.
   val auth=android.util.Base64.encodeToString(("cw:"+password).toByteArray(Charsets.UTF_8),android.util.Base64.NO_WRAP)
   socket.getOutputStream().write(("CONNECT "+host+":443 HTTP/1.1\r\nHost: "+host+":443\r\nProxy-Authorization: Basic "+auth+"\r\n\r\n").toByteArray(Charsets.US_ASCII))
   // This buffer reads only the CONNECT response; the TLS handshake hasn't been sent yet.
   check(headers(BufferedInputStream(socket.getInputStream())).first==200){"probe_connect"}
   val tls=(SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket,host,443,true) as SSLSocket
   onSocket(tls);tls.soTimeout=3500
   val params=tls.sslParameters;params.endpointIdentificationAlgorithm="HTTPS";tls.sslParameters=params
   tls.startHandshake()
   tls.getOutputStream().write(("GET "+path+" HTTP/1.1\r\nHost: "+host+"\r\nConnection: close\r\nAccept-Encoding: identity\r\n\r\n").toByteArray(Charsets.US_ASCII))
   val input=BufferedInputStream(tls.inputStream)
   val (code,h)=headers(input)
   if(!fallback)return accepts(false,code,"")
   if(code!=200)return false
   val bytes=java.io.ByteArrayOutputStream()
   if(h["transfer-encoding"]?.lowercase()=="chunked") {
    fun line():String{val result=StringBuilder();while(result.length<128){val n=input.read();check(n>=0);result.append(n.toChar());if(result.endsWith("\r\n"))return result.dropLast(2).toString()};error("probe_body")}
    while(true){
     val size=line().substringBefore(';').toInt(16);check(size>=0 && bytes.size()+size<=4096){"probe_body"}
     if(size==0)break
     repeat(size){val n=input.read();check(n>=0);bytes.write(n)};check(line().isEmpty())
    }
   }else{
    val length=h["content-length"]?.toInt()?:4097
    check(length in 0..4097)
    while(bytes.size()<length){val n=input.read();if(n<0)break;bytes.write(n);check(bytes.size()<=4096){"probe_body"}}
    if(h.containsKey("content-length"))check(bytes.size()==length)
   }
   return accepts(true,code,bytes.toString("UTF-8"))
  }finally{runCatching{socket.close()};onSocket(null)}
 }
}
