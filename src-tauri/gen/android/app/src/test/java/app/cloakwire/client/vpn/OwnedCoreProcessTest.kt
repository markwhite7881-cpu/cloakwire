package app.cloakwire.client.vpn

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class OwnedCoreProcessTest {
  private fun sleeper(): Process = if (File.separatorChar == '\\')
    ProcessBuilder("powershell.exe","-NoProfile","-NonInteractive","-Command","Start-Sleep -Seconds 60").start()
  else ProcessBuilder("sh","-c","exec sleep 60").start()

  @Test fun session_cleanup_preserves_probe_process_and_its_config() {
    val root=Files.createTempDirectory("core-owners").toFile()
    val session=CoreProcessOwner(root); val probe=CoreProcessOwner(root)
    try {
      val a=session.start("session"){sleeper()}
      val b=probe.start("probe"){sleeper()}
      assertNotEquals(a.configFile,b.configFile)
      session.close()
      assertFalse(a.process.isAlive)
      assertTrue(b.process.isAlive)
      assertEquals("probe",b.configFile.readText())
      assertFalse(a.configFile.exists())
    } finally {session.close();probe.close();root.deleteRecursively()}
  }
  @Test fun probe_cleanup_preserves_session_process_and_its_config() {
    val root=Files.createTempDirectory("core-owners").toFile()
    val session=CoreProcessOwner(root); val probe=CoreProcessOwner(root)
    try {
      val a=session.start("session"){sleeper()}
      val b=probe.start("probe"){sleeper()}
      probe.close()
      assertFalse(b.process.isAlive)
      assertTrue(a.process.isAlive)
      assertEquals("session",a.configFile.readText())
    } finally {session.close();probe.close();root.deleteRecursively()}
  }
  @Test fun retired_owner_rejects_delayed_restart_without_spawning() {
    val root=Files.createTempDirectory("core-owners").toFile()
    val owner=CoreProcessOwner(root)
    try {
      owner.start("original"){sleeper()}
      owner.close()
      var spawned=false
      assertThrows(IllegalStateException::class.java) {
        owner.start("late"){spawned=true;sleeper()}
      }
      assertFalse(spawned)
      assertTrue(root.listFiles()!!.isEmpty())
    } finally {owner.close();root.deleteRecursively()}
  }
  @Test fun old_child_exit_cannot_delete_new_child_config() {
    val root=Files.createTempDirectory("core-owners").toFile()
    val owner=CoreProcessOwner(root)
    try {
      val old=owner.start("old"){sleeper()}
      val current=owner.start("current"){sleeper()}
      old.close()
      assertTrue(current.process.isAlive)
      assertEquals("current",current.configFile.readText())
    } finally {owner.close();root.deleteRecursively()}
  }
  @Test fun failed_spawn_does_not_leave_private_config() {
    val root=Files.createTempDirectory("core-owners").toFile()
    val owner=CoreProcessOwner(root)
    try {
      assertThrows(java.io.IOException::class.java) {
        owner.start("private"){throw java.io.IOException("fixture")}
      }
      assertTrue(root.listFiles()!!.isEmpty())
    } finally {owner.close();root.deleteRecursively()}
  }
  @Test fun stale_restart_cannot_publish_or_fail_new_session() {
    val generations=SessionGeneration()
    val old=generations.begin()
    val current=generations.begin()
    var visible="current"
    assertFalse(generations.runIfCurrent(old){visible="old restarted"})
    assertEquals("current",visible)
    assertTrue(generations.runIfCurrent(current){visible="current ready"})
    generations.begin()
    assertFalse(generations.runIfCurrent(current){visible="resurrected after stop"})
    assertEquals("current ready",visible)
  }
  @Test fun generation_publish_uses_the_same_gate_as_service_teardown() {
    val gate=Any()
    val generations=SessionGeneration(gate)
    val token=generations.begin()
    val entered=java.util.concurrent.CountDownLatch(1)
    val started=java.util.concurrent.CountDownLatch(1)
    val worker=Thread {started.countDown();generations.runIfCurrent(token){entered.countDown()}}
    synchronized(gate) {
      worker.start()
      assertTrue(started.await(1,java.util.concurrent.TimeUnit.SECONDS))
      assertFalse(entered.await(50,java.util.concurrent.TimeUnit.MILLISECONDS))
      generations.begin()
    }
    worker.join(1000)
    assertFalse(worker.isAlive)
    assertEquals(1L,entered.count)
  }
}
