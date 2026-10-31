package app.cloakwire.client.vpn

import java.io.File
import org.json.JSONObject

/** Recovery visits only our recorded leases, never all processes with a matching name. */
internal object CoreProcessRecovery {
  private fun read(pid:Int):CoreProcessIdentity?=runCatching {
    val dir=File("/proc/$pid")
    CoreProcessIdentity.fromProc(File(dir,"stat").readText(),File(dir,"status").readText(),File(dir,"cmdline").readText())
  }.getOrNull()

  fun record(file:File,binary:String) {
    val owner=read(android.os.Process.myPid())?:return
    // The new child may still be in exec for a moment. A missing witness is never permission to kill.
    val until=System.nanoTime()+200_000_000
    do {
      val child=File("/proc").listFiles()?.asSequence()?.mapNotNull {it.name.toIntOrNull()}
        ?.mapNotNull(::read)?.firstOrNull {it.uid==owner.uid&&it.command==listOf(binary,"run","-c",file.absolutePath)}
      if(child!=null) {
        File(file.path+".owner").writeText(OrphanLease(owner,child,file.absolutePath).toJson().toString())
        return
      }
      Thread.sleep(5)
    }while(System.nanoTime()<until)
  }

  @Synchronized fun reap(directory:File) {
    val parent=directory.canonicalFile
    val uid=android.os.Process.myUid()
    for(record in parent.listFiles().orEmpty()) {
      if(!record.name.matches(Regex("core-[a-zA-Z0-9-]+\\.json\\.owner")) || record.length()>8192)continue
      val lease=runCatching{OrphanLease.fromJson(JSONObject(record.readText()))}.getOrNull()?:continue
      val config=File(record.path.removeSuffix(".owner"))
      if(config.canonicalFile.parentFile!=parent || lease.config!=config.absolutePath)continue
      val owner=read(lease.owner.pid)
      if(owner==null && File("/proc/${lease.owner.pid}").exists())continue // Unreadable is not dead.
      if(!lease.canReap(read(lease.child.pid),owner,uid,config.absolutePath))continue
      // Re-read immediately before the signal; an expired PID alone is never ownership.
      if(!lease.canReap(read(lease.child.pid),read(lease.owner.pid),uid,config.absolutePath))continue
      android.os.Process.sendSignal(lease.child.pid,android.os.Process.SIGNAL_KILL)
      val until=System.nanoTime()+1_000_000_000
      while(read(lease.child.pid)==lease.child && System.nanoTime()<until)Thread.sleep(10)
      check(read(lease.child.pid)!=lease.child){"core_cleanup_unconfirmed"}
      config.delete();record.delete()
    }
  }
}
