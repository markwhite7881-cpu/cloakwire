package app.cloakwire.client.vpn
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
class ProbeResourcesTest {
 @Test fun cancellation_before_owner_publication_retires_owner_before_spawn() {
  val resources=ProbeResources();val ready=CountDownLatch(1);val proceed=CountDownLatch(1)
  val root=kotlin.io.path.createTempDirectory("probe-publication").toFile()
  var spawned=false
  val worker=Thread {
   val owner=CoreProcessOwner(root);ready.countDown();proceed.await()
   if(resources.own(owner))runCatching{owner.start("{}"){spawned=true;throw IllegalStateException("spawned")}}
  }
  worker.start();assertTrue(ready.await(2,TimeUnit.SECONDS));resources.close();proceed.countDown();worker.join(2000)
  assertFalse(worker.isAlive);assertFalse(spawned);assertTrue(root.listFiles().orEmpty().isEmpty());root.delete()
 }
 @Test fun physical_dns_and_routes_change_generation_without_changing_handle(){
  val base=ProbeNetworkKey("1","wlan0",listOf("192.0.2.53"),listOf("192.0.2.2/24"),listOf("default"),1500,true,false)
  assertEquals(base.revision(),base.copy(dns=listOf("192.0.2.53")).revision())
  assertNotEquals(base.revision(),base.copy(dns=listOf("192.0.2.54")).revision())
  assertNotEquals(base.revision(),base.copy(routes=listOf("other")).revision())
  assertNotEquals(base.revision(),base.copy(validated=false).revision())
 }
}
