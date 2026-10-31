package app.cloakwire.client.vpn
import java.io.Closeable
import java.io.File

/** Heavy writes/fsync happen before ownership locks; publish is one atomic same-directory rename. */
internal class RecoveryConfigStore(private val target:File,private val write:(File,String)->Unit,private val replace:(File,File)->Unit) {
 inner class Staged internal constructor(private val candidate:File):Closeable {
  fun publish(){replace(candidate,target)}
  override fun close(){candidate.delete()}
 }
 fun stage(config:String):Staged {
  val candidate=File.createTempFile(".cw-accepted-",".json",target.parentFile)
  try{write(candidate,config);return Staged(candidate)}catch(error:Throwable){candidate.delete();throw error}
 }
}
internal object RecoveryPreferenceChange {
 fun apply(enabled:Boolean,persist:(Boolean)->Boolean,activate:(Boolean)->Unit) {
  if(!enabled)activate(false)
  check(persist(enabled)){"recovery_setting_failed"}
  if(enabled)activate(true)
 }
}

/** Shared across Activity/plugin instances. Disk ordering and native activation follow latest intent. */
internal class RecoveryPreferenceWriter {
 data class Ticket(val id:Long,val enabled:Boolean)
 private val intentGate=Any()
 private val diskGate=Any()
 private var generation=0L
 fun begin(enabled:Boolean,activate:(Boolean)->Unit):Ticket=synchronized(intentGate) {
  val ticket=Ticket(++generation,enabled)
  if(!enabled)activate(false)
  ticket
 }
 fun commit(ticket:Ticket,persist:(Boolean)->Boolean,activate:(Boolean)->Unit) {
  synchronized(diskGate) {
   if(!synchronized(intentGate){ticket.id==generation})return
   RecoveryPreferenceChange.apply(ticket.enabled,persist){value->
    synchronized(intentGate){if(ticket.id==generation)activate(value)}
   }
  }
 }
}
internal object NativeRecoveryPreferences {val writer=RecoveryPreferenceWriter()}
