package app.cloakwire.client.vpn

import java.io.Closeable
import java.io.File
import java.util.concurrent.TimeUnit

/** A lease owns one child and one unique config. No process-name or PID-wide cleanup. */
internal class OwnedCoreProcess private constructor(
  val process: Process,
  val configFile: File,
) : Closeable {
  companion object {
    fun start(directory: File, config: String, spawn: (File) -> Process): OwnedCoreProcess {
      check(directory.isDirectory || directory.mkdirs()) { "core_directory_unavailable" }
      val file=File.createTempFile("core-", ".json", directory)
      try {
        file.writeText(config)
        return OwnedCoreProcess(spawn(file),file)
      } catch (error: Exception) { file.delete();throw error }
    }
  }

  @Synchronized override fun close() {
    // Process retains the child identity; never signal a PID obtained from a name scan.
    if (process.isAlive) {
      process.destroy()
      if (!process.waitFor(500,TimeUnit.MILLISECONDS)) {
        process.destroyForcibly()
        check(process.waitFor(1500,TimeUnit.MILLISECONDS)) { "core_cleanup_unconfirmed" }
      }
    }
    check(!process.isAlive) { "core_cleanup_unconfirmed" }
    // Failed cleanup intentionally retains the private config and prevents replacement.
    configFile.delete()
    File(configFile.path+".owner").delete()
  }
}

/** Retirement is permanent: a delayed session restart must use neither this owner nor a new child. */
internal class CoreProcessOwner(private val directory:File) : Closeable {
  private var retired=false
  private var current:OwnedCoreProcess?=null

  @Synchronized fun start(config:String,spawn:(File)->Process):OwnedCoreProcess {
    check(!retired) { "core_owner_retired" }
    current?.close()
    current=null
    return OwnedCoreProcess.start(directory,config,spawn).also { current=it }
  }
  @Synchronized override fun close() {
    retired=true
    current?.close()
    current=null
  }
}

/** Publish callbacks only while they still own the accepted lifecycle generation. */
internal class SessionGeneration(private val gate:Any=Any()) {
  private var value=0L
  fun begin():Long = synchronized(gate) { ++value }
  fun current():Long = synchronized(gate) { value }
  fun runIfCurrent(expected:Long,action:()->Unit):Boolean = synchronized(gate) {
    if(expected!=value)return false
    action()
    true
  }
}
