package app.cloakwire.client.vpn

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class ProcessProfileCheckTest {
  private fun command(script: String): ProcessBuilder = if (File.separatorChar == '\\') {
    ProcessBuilder("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script)
  } else {
    ProcessBuilder("sh", "-c", script)
  }

  @Test fun `checker consumes candidate file and removes it after success`() {
    val dir = Files.createTempDirectory("profile-check-test").toFile()
    try {
      var consumed = false
      ProcessProfileCheck.check("candidate-private-config", dir, 5000) { file ->
        assertEquals("candidate-private-config", file.readText())
        consumed = true
        command("exit 0").start()
      }
      assertTrue(consumed)
      assertTrue(dir.listFiles()!!.isEmpty())
    } finally { dir.deleteRecursively() }
  }

  @Test fun `rejected process returns only safe reason and removes candidate`() {
    val dir = Files.createTempDirectory("profile-check-test").toFile()
    try {
      val script = if (File.separatorChar == '\\') {
        "Write-Output 'initialize DNS server[0]: address_resolver not found: private-name'; exit 1"
      } else {
        "echo 'initialize DNS server[0]: address_resolver not found: private-name'; exit 1"
      }
      val failure = assertThrows(ProfileCheckException::class.java) {
        ProcessProfileCheck.check("candidate-private-config", dir, 5000) { command(script).start() }
      }
      assertEquals("profile_check_dns", failure.message)
      assertNull(failure.cause)
      assertTrue(dir.listFiles()!!.isEmpty())
    } finally { dir.deleteRecursively() }
  }

  @Test fun `timeout kills only checker process and removes candidate`() {
    val dir = Files.createTempDirectory("profile-check-test").toFile()
    var process: Process? = null
    try {
      val script = if (File.separatorChar == '\\') "Start-Sleep -Seconds 30" else "exec sleep 30"
      val failure = assertThrows(ProfileCheckException::class.java) {
        ProcessProfileCheck.check("candidate-private-config", dir, 50) {
          command(script).start().also { process = it }
        }
      }
      assertEquals("profile_check_timeout", failure.message)
      assertNotNull(process)
      assertFalse(process!!.isAlive)
      assertTrue(dir.listFiles()!!.isEmpty())
    } finally { process?.destroyForcibly(); dir.deleteRecursively() }
  }

  @Test fun `missing executable returns unavailable and removes candidate`() {
    val dir = Files.createTempDirectory("profile-check-test").toFile()
    try {
      val failure = assertThrows(ProfileCheckException::class.java) {
        ProcessProfileCheck.check("candidate-private-config", dir, 50) {
          ProcessBuilder(File(dir, "missing-core").absolutePath).start()
        }
      }
      assertEquals("profile_check_unavailable", failure.message)
      assertTrue(dir.listFiles()!!.isEmpty())
    } finally { dir.deleteRecursively() }
  }
}
