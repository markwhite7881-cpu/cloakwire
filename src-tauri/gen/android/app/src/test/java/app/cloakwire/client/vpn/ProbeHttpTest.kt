package app.cloakwire.client.vpn
import org.junit.Assert.*
import org.junit.Test
class ProbeHttpTest {
 @Test fun redirects_and_arbitrary_success_pages_do_not_prove_access(){
  assertTrue(ProbeHttp.accepts(false,204,""))
  assertFalse(ProbeHttp.accepts(false,302,""))
  assertFalse(ProbeHttp.accepts(false,200,"login"))
  assertFalse(ProbeHttp.accepts(true,200,"<html>login</html>"))
  assertTrue(ProbeHttp.accepts(true,200,"h=www.cloudflare.com\nip=192.0.2.1\ntls=TLSv1.3\n"))
  assertFalse(ProbeHttp.accepts(true,200,"x".repeat(4097)))
 }
}
