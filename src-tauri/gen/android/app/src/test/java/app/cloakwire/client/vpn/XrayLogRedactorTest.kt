package app.cloakwire.client.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class XrayLogRedactorTest {

  @Test
  fun `share link line is dropped entirely`() {
    assertNull(XrayLogRedactor.redact("connecting to vless://abcd@host:443?type=ws#frag"))
    assertNull(XrayLogRedactor.redact("vmess://eyJhZGQiOiJleGFtcGxlLmNvbSJ9"))
    assertNull(XrayLogRedactor.redact("ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ="))
    assertNull(XrayLogRedactor.redact("trojan://password@example.com:443"))
    assertNull(XrayLogRedactor.redact("hysteria://auth@host:443"))
  }

  @Test
  fun `uuid is redacted`() {
    val out = XrayLogRedactor.redact("client uuid 11111111-2222-3333-4444-555555555555 ready")
    assertEquals("client uuid [REDACTED-UUID] ready", out)
  }

  @Test
  fun `uppercase uuid is redacted`() {
    val out = XrayLogRedactor.redact("UUID=ABCDEF12-3456-7890-ABCD-EF1234567890")
    assertNotNull(out)
    assert(!out!!.contains("ABCDEF12"))
    assert(out.contains("[REDACTED-UUID]"))
  }

  @Test
  fun `base64 key is redacted`() {
    val key = "A".repeat(40)
    val out = XrayLogRedactor.redact("reality key=$key")
    assertNotNull(out)
    assert(!out!!.contains(key))
  }

  @Test
  fun `plain log line passes through unchanged`() {
    val line = "[Info] core started, listening on 0.0.0.0:0"
    assertEquals(line, XrayLogRedactor.redact(line))
  }

  @Test
  fun `empty line passes through`() {
    assertEquals("", XrayLogRedactor.redact(""))
  }

  @Test
  fun `password field is redacted`() {
    val out = XrayLogRedactor.redact("dialing with password=supersecret123")
    assertNotNull(out)
    assert(!out!!.contains("supersecret123"))
    assert(out.contains("[REDACTED-PASSWORD]"))
  }

  @Test
  fun `password field with quotes is redacted and keeps quote style`() {
    val out = XrayLogRedactor.redact("""config password="my pass"""")
    assertNotNull(out)
    assert(!out!!.contains("my pass"))
    assert(out.contains("\"[REDACTED-PASSWORD]\""))
  }

  @Test
  fun `short base64-looking token is not redacted`() {
    val out = XrayLogRedactor.redact("user abc loaded")
    assertEquals("user abc loaded", out)
  }

  @Test
  fun `share link in middle of line still drops the line`() {
    assertNull(XrayLogRedactor.redact("hello vless://abc@host world"))
  }
}
