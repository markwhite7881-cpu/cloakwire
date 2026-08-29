package hev.htproxy

/**
 * JNI binding surface for the bundled libhev-socks5-tunnel.so.
 *
 * The C library uses RegisterNatives (in JNI_OnLoad) to bind its
 * TProxyStartService / TProxyStopService / TProxyIsRunning / TProxyGetStats
 * functions to a Java class with the exact fully-qualified name
 * "hev.htproxy.TProxyService". The class and method names must
 * match exactly; the C side has no fallback to JNI naming convention.
 *
 * Methods are declared on the companion object and annotated with
 * @JvmStatic so the native function pointer signatures
 * (JNIEnv*, jclass) match the C side's expectations.
 *
 * This class is intentionally a thin pass-through — it has no
 * business logic. Application code should depend on
 * `ru.classquiz.singbox.vpn.Tun2SocksService` instead, which
 * wraps these natives with config generation, lifecycle, logging,
 * and error handling.
 */
object TProxyService {
    init {
        // Trigger JNI_OnLoad. The C side will FindClass(this class)
        // and RegisterNatives the four TProxy* methods. If anything
        // is mis-wired (wrong package, R8 stripped, missing .so),
        // UnsatisfiedLinkError surfaces here, not at the call site.
        System.loadLibrary("hev-socks5-tunnel")
    }

    @JvmStatic
    external fun TProxyStartService(configPath: String, fd: Int): Boolean

    @JvmStatic
    external fun TProxyStopService(): Boolean

    @JvmStatic
    external fun TProxyIsRunning(): Boolean

    @JvmStatic
    external fun TProxyGetStats(): LongArray?
}
