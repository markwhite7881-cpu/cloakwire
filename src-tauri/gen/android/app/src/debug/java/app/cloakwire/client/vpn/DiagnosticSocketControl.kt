package app.cloakwire.client.vpn

import android.net.Network
import android.net.VpnService
import java.net.*
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import org.json.JSONObject

/** Same-UID/network control without libbox. Fixed public probes, safe summaries only. */
internal object DiagnosticSocketControl {
    private const val HOST = "www.gstatic.com"
    fun run(network: Network, dns: String, protect: Boolean, viaXray: Boolean = false): JSONObject {
        val report = JSONObject().put("protectedMode", protect)
        fun measure(name: String, operation: () -> Boolean) {
            val start = System.nanoTime()
            try { report.put(name, operation()) }
            catch (error: Exception) { report.put(name, false).put(name+"Error", error.javaClass.simpleName) }
            report.put(name+"Ms", (System.nanoTime()-start)/1_000_000)
        }
        if (!viaXray) {
            measure("networkDnsUdp") { udp(network, InetAddress.getByName(dns), protect) }
            measure("publicDnsUdp") { udp(network, InetAddress.getByName("1.1.1.1"), protect) }
        }
        measure("https204") {
            val addresses = network.getAllByName(HOST)
            report.put("ipv4Count", addresses.count { it is Inet4Address })
            report.put("ipv6Count", addresses.count { it is Inet6Address })
            val address = addresses.firstOrNull { it is Inet4Address } ?: error("no_ipv4")
            val transport = if (viaXray) Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1",10808))) else Socket()
            transport.use { socket ->
                if (!viaXray) {
                    socket.bind(InetSocketAddress(0))
                    if (protect) check(VpnService().protect(socket)) { "protect_failed" }
                    network.bindSocket(socket)
                }
                socket.soTimeout = 3000
                socket.connect(InetSocketAddress(address,443),3000)
                ((SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket,HOST,443,true) as SSLSocket).use { tls ->
                    tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                    tls.soTimeout = 3000
                    tls.startHandshake()
                    tls.outputStream.write(("GET /generate_204 HTTP/1.1\r\nHost: "+HOST+"\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII))
                    tls.outputStream.flush()
                    tls.inputStream.bufferedReader(Charsets.US_ASCII).readLine()?.matches(Regex("HTTP/1\\.[01] 204(?: .*)?")) == true
                }
            }
        }
        return report
    }
    private fun udp(network: Network, dns: InetAddress, protect: Boolean): Boolean {
        DatagramSocket().use { socket ->
            if (protect) check(VpnService().protect(socket)) { "protect_failed" }
            network.bindSocket(socket)
            socket.soTimeout = 3000
            socket.connect(dns,53)
            val query=byteArrayOf(0x43,0x57,1,0,0,1,0,0,0,0,0,0,3,119,119,119,7,103,115,116,97,116,105,99,3,99,111,109,0,0,1,0,1)
            socket.send(DatagramPacket(query,query.size))
            val response=DatagramPacket(ByteArray(4096),4096);socket.receive(response)
            val bytes=response.data
            return response.length>=12 && bytes[0]==0x43.toByte() && bytes[1]==0x57.toByte() &&
                (bytes[2].toInt() and 0x80)!=0 && (bytes[3].toInt() and 15)==0
        }
    }
}
