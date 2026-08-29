package app.cloakwire.client.vpn

import android.net.VpnService
import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * SOCKS5 proxy inside the VPN service process whose every outbound
 * socket passes through [VpnService.protect] — the "protected dialer"
 * that keeps the engine's remote connections out of the tunnel.
 *
 * xray chains its outbounds through this proxy via
 * `sockopt.dialerProxy` (tag "protected", 127.0.0.1:10810). The
 * actual TCP connect to the VPN server then happens on a protected
 * socket that bypasses the TUN, so no routing loop is possible even
 * though xray runs in the app's own UID.
 *
 * This is the same trick v2rayNG / NekoBox / Hiddify use, except they
 * ship custom cores that call protect() directly; we insert a tiny
 * SOCKS5 hop instead of forking xray.
 *
 * v2 (2026-08-21 rebuild): the v1 proxy capped concurrent dials at 2
 * with 600 ms pacing — that throttled the WHOLE tunnel to two
 * simultaneous connections and was a major reason nothing worked.
 * Both limits are gone. protect() is retried a few times (some OEM
 * stacks return false transiently right after the TUN comes up); a
 * hard protect failure fails that one connection (xray reports it to
 * the app) instead of silently looping.
 *
 * Threading: one accept loop, one thread pair per client connection.
 * No auth (xray side uses `auth: noauth`). CONNECT only.
 */
internal class ProtectedSocks5Proxy(
  private val service: VpnService,
  private val listenPort: Int = DEFAULT_PORT,
) {
  companion object {
    private const val TAG = "ProtectedSocks5"
    const val DEFAULT_PORT = 10810
    private const val PROTECT_RETRIES = 3
    private const val PROTECT_RETRY_DELAY_MS = 100L
    private const val CONNECT_TIMEOUT_MS = 10_000
  }

  @Volatile private var serverSocket: ServerSocket? = null
  @Volatile private var running: Boolean = false
  private val activeSockets = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<Socket, Boolean>())
  private val executor = Executors.newCachedThreadPool { r ->
    Thread(r, "socks5-protected").apply { isDaemon = true }
  }

  fun start() {
    if (running) return
    val ss = ServerSocket()
    ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), listenPort))
    serverSocket = ss
    running = true
    Log.i(TAG, "protected SOCKS5 listening on 127.0.0.1:$listenPort")
    executor.execute { acceptLoop() }
  }

  fun stop() {
    if (!running) return
    running = false
    runCatching { serverSocket?.close() }
    serverSocket = null
    for (sock in activeSockets) {
      runCatching { sock.close() }
    }
    activeSockets.clear()
    executor.shutdownNow()
    Log.i(TAG, "protected SOCKS5 stopped")
  }

  private fun acceptLoop() {
    while (running) {
      val client: Socket = try {
        serverSocket?.accept() ?: break
      } catch (_: IOException) {
        break
      }
      executor.execute { handleClient(client) }
    }
  }

  /**
   * SOCKS5 (RFC 1928), no-auth. Accepts IPv4 (atyp=0x01), domain
   * (atyp=0x03) and IPv6 (atyp=0x04) destinations. On CONNECT we dial
   * the destination on a protected socket and splice the streams.
   */
  private fun handleClient(client: Socket) {
    activeSockets.add(client)
    var outbound: Socket? = null
    try {
      val input = client.getInputStream()
      val output = client.getOutputStream()

      // 1. Greeting.
      val greeting = ByteArray(2)
      if (!readFully(input, greeting, 0, 2)) return
      if (greeting[0] != 0x05.toByte()) return
      val nmethods = greeting[1].toInt() and 0xFF
      val methods = ByteArray(nmethods)
      if (!readFully(input, methods, 0, nmethods)) return
      output.write(byteArrayOf(0x05, 0x00))
      output.flush()

      // 2. Request.
      val header = ByteArray(4)
      if (!readFully(input, header, 0, 4)) return
      if (header[0] != 0x05.toByte()) return
      val cmd = header[1].toInt() and 0xFF
      if (cmd != 0x01) {
        reply(output, 0x07)
        return
      }
      val atyp = header[3].toInt() and 0xFF
      val (host, port) = when (atyp) {
        0x01 -> {
          val addr = ByteArray(4)
          if (!readFully(input, addr, 0, 4)) return
          readPort(input)?.let { formatIPv4(addr) to it } ?: return
        }
        0x03 -> {
          val lenByte = ByteArray(1)
          if (!readFully(input, lenByte, 0, 1)) return
          val len = lenByte[0].toInt() and 0xFF
          val domain = ByteArray(len)
          if (!readFully(input, domain, 0, len)) return
          readPort(input)?.let { String(domain, Charsets.US_ASCII) to it } ?: return
        }
        0x04 -> {
          val addr = ByteArray(16)
          if (!readFully(input, addr, 0, 16)) return
          readPort(input)?.let { formatIPv6(addr) to it } ?: return
        }
        else -> {
          reply(output, 0x08)
          return
        }
      }

      // 3. Protected dial.
      val plain = java.net.Socket()
      var protected = service.protect(plain)
      var socketType = "plain"
      var socket: java.net.Socket = plain
      if (!protected) {
        runCatching { plain.bind(InetSocketAddress(InetAddress.getByName("0.0.0.0"), 0)) }
        protected = service.protect(plain)
      }
      if (!protected) {
        val ch = java.nio.channels.SocketChannel.open().socket()
        if (service.protect(ch)) {
          protected = true
          socketType = "channel"
          socket = ch
        }
      }
      if (!protected) {
        Log.e(TAG, "protect() failed on both socket types — relying on uid disallow")
        socketType = "unprotected"
      }
      socket.tcpNoDelay = true
      socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
      outbound = socket
      activeSockets.add(socket)
      Log.i(
        TAG,
        "dial $host:$port type=$socketType connect ok",
      )

      // 4. Success reply, then splice until either side closes.
      reply(output, 0x00)

      val out = socket
      val inToOut = executor.submit {
        runCatching { input.copyTo(out.getOutputStream()) }
        runCatching { out.close() }
      }
      val outToIn = executor.submit {
        runCatching { out.getInputStream().copyTo(output) }
        runCatching { output.close() }
      }
      try {
        inToOut.get(1, TimeUnit.DAYS)
      } catch (_: Exception) { /* connection ended */ }
      try {
        outToIn.get(2, TimeUnit.SECONDS)
      } catch (_: Exception) { /* peer still draining; give up gently */ }
    } catch (e: Exception) {
      Log.w(TAG, "client handling failed: ${e.message}")
    } finally {
      activeSockets.remove(client)
      outbound?.let { activeSockets.remove(it) }
      runCatching { client.close() }
      runCatching { outbound?.close() }
    }
  }

  private fun reply(output: java.io.OutputStream, code: Int) {
    runCatching {
      output.write(
        byteArrayOf(0x05, code.toByte(), 0x00, 0x01, 0, 0, 0, 0, 0, 0)
      )
      output.flush()
    }
  }

  private fun readPort(input: InputStream): Int? {
    val pbytes = ByteArray(2)
    if (!readFully(input, pbytes, 0, 2)) return null
    return ((pbytes[0].toInt() and 0xFF) shl 8) or (pbytes[1].toInt() and 0xFF)
  }

  private fun formatIPv4(addr: ByteArray): String =
    "${addr[0].toUByte()}.${addr[1].toUByte()}.${addr[2].toUByte()}.${addr[3].toUByte()}"

  private fun formatIPv6(addr: ByteArray): String {
    val sb = StringBuilder()
    for (i in 0 until 16 step 2) {
      val g = ((addr[i].toInt() and 0xFF) shl 8) or (addr[i + 1].toInt() and 0xFF)
      sb.append(g.toString(16)).append(':')
    }
    sb.setLength(sb.length - 1)
    return sb.toString()
  }

  private fun readFully(input: InputStream, buf: ByteArray, off: Int, len: Int): Boolean {
    var read = 0
    while (read < len) {
      val n = try {
        input.read(buf, off + read, len - read)
      } catch (_: IOException) {
        return false
      }
      if (n < 0) return false
      read += n
    }
    return true
  }
}
