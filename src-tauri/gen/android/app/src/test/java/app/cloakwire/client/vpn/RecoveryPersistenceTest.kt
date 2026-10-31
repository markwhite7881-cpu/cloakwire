package app.cloakwire.client.vpn
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import org.junit.Assert.*
import org.junit.Test
class RecoveryPersistenceTest {
 @Test fun failed_config_staging_keeps_old_file_and_recovery_owner_accepted() {
  val directory=Files.createTempDirectory("recovery-persist").toFile()
  try {
   val destination=File(directory,"active.json").apply{writeText("old")}
   val c=RecoveryCoordinator(true);val old=RecoverySnapshot("a","old","[]","exclude","xray","on_drop",true,"old",null,"run-a")
   val epoch=c.accept(old,0);c.network("wifi",false,0);c.pausePreparation(10)
   val store=RecoveryConfigStore(destination,{_,_->throw java.io.IOException("disk full")}){a,b->Files.move(a.toPath(),b.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);Unit}
   assertThrows(java.io.IOException::class.java){store.stage("new").use{it.publish()}}
   assertSame(old,c.snapshot());assertEquals(epoch,c.epoch());assertEquals("old",destination.readText())
   assertTrue(c.resumePreparation(10,1));assertTrue(c.engineDied(epoch,1));assertNotNull(c.next(2001))
  }finally{directory.deleteRecursively()}
 }
 @Test fun cancellation_after_staging_never_replaces_old_config() {
  val directory=Files.createTempDirectory("recovery-persist").toFile()
  try {
   val destination=File(directory,"active.json").apply{writeText("old")}
   var current=true
   val store=RecoveryConfigStore(destination,{file,config->file.writeText(config);current=false}){a,b->Files.move(a.toPath(),b.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);Unit}
   val c=RecoveryCoordinator(true);val original=RecoverySnapshot("a","old","[]","exclude","xray","on_drop",true,"old",null,"run-a")
   c.accept(original,0);c.pausePreparation(10)
   store.stage("new").use{staged->
    if(!current)c.cancel()
    assertFalse(c.acceptPreparation(10,original.copy(id="b",config="new"),1){staged.publish()})
   }
   assertEquals("old",destination.readText());assertEquals(listOf("active.json"),directory.list()!!.toList())
  }finally{directory.deleteRecursively()}
 }
 @Test fun old_blocked_enable_cannot_activate_after_new_disable_across_plugin_instances() {
  val writer=RecoveryPreferenceWriter();val entered=java.util.concurrent.CountDownLatch(1);val release=java.util.concurrent.CountDownLatch(1)
  val enabled=java.util.concurrent.atomic.AtomicBoolean(false);val durable=java.util.concurrent.atomic.AtomicBoolean(false)
  val old=writer.begin(true){enabled.set(it)}
  val worker=Thread {writer.commit(old,{value->entered.countDown();release.await();durable.set(value);true}){enabled.set(it)}}
  worker.start();assertTrue(entered.await(1,java.util.concurrent.TimeUnit.SECONDS))
  val latest=writer.begin(false){enabled.set(it)}
  release.countDown();worker.join(1000)
  assertFalse(worker.isAlive);assertFalse(enabled.get())
  writer.commit(latest,{value->durable.set(value);true}){enabled.set(it)}
  assertFalse(enabled.get());assertFalse(durable.get())
 }
 @Test fun enable_failure_keeps_native_disabled_and_disable_failure_cancels_before_reporting_error() {
  var enabled=false
  assertThrows(IllegalStateException::class.java){RecoveryPreferenceChange.apply(true,{false}){enabled=it}}
  assertFalse(enabled)
  enabled=true
  assertThrows(IllegalStateException::class.java){RecoveryPreferenceChange.apply(false,{false}){enabled=it}}
  assertFalse(enabled)
 }
}
