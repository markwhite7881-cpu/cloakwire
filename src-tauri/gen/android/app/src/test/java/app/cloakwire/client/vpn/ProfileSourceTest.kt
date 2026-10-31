package app.cloakwire.client.vpn
import org.junit.Assert.*
import org.junit.Test
class ProfileSourceTest {
 private fun source(key:String="index-0",revision:String="a".repeat(64))=ProfileSource(ProfileRef.Subscription("sub",key),revision)
 @Test fun sourceRoundTripNeverNeedsConfig() {
  val owner=source();assertEquals(owner,ProfileSource.parse(owner.toJson().toString()))
  assertFalse(owner.toJson().toString().contains("password"))
 }
 @Test fun replacingIndexChangesOwner(){
  assertNotEquals(source(),source(revision="b".repeat(64)));assertNotEquals(source(),source(key="index-1"))
 }
 @Test fun malformedSourceIsRejected(){
  assertNull(ProfileSource.parse(""))
  try{ProfileSource.parse(source(revision="secret").toJson().toString());fail()}catch(_:IllegalArgumentException){}
 }
 @Test fun evidenceNamesItsScopeAndNeverClaimsNetworkAccess(){
  val value=ProfileCheckEvidence(source(),"passed",123).toJson()
  assertEquals("preflight",value.getString("kind"));assertEquals(123,value.getLong("checked_at"))
  assertFalse(value.toString().contains("healthy"))
 }
}
