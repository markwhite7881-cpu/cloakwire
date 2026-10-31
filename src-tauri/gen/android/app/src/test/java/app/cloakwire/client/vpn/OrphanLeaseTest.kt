package app.cloakwire.client.vpn
import org.junit.Assert.*
import org.junit.Test

class OrphanLeaseTest {
  private val command=listOf("/app/lib/libxray.so","run","-c","/private/session/core-token.json")
  private val owner=CoreProcessIdentity(100,10123,500L,listOf("app.cloakwire.client"))
  private val child=CoreProcessIdentity(101,10123,700L,command)
  private val lease=OrphanLease(owner,child,"/private/session/core-token.json")
  @Test fun only_dead_owner_and_exact_child_identity_allow_cleanup() {
    assertTrue(lease.canReap(child,null,10123,"/private/session/core-token.json"))
    assertFalse(lease.canReap(child,owner,10123,"/private/session/core-token.json"))
    assertFalse(lease.canReap(child.copy(startTicks=701),null,10123,"/private/session/core-token.json"))
    assertFalse(lease.canReap(child.copy(uid=0),null,10123,"/private/session/core-token.json"))
    assertFalse(lease.canReap(child.copy(command=command.dropLast(1)+"/private/probe/core-other.json"),null,10123,"/private/session/core-token.json"))
    assertFalse(lease.canReap(child,null,10123,"/private/probe/core-token.json"))
  }
  @Test fun owner_pid_reuse_does_not_adopt_old_child() {
    assertTrue(lease.canReap(child,owner.copy(startTicks=999),10123,"/private/session/core-token.json"))
  }
  @Test fun proc_stat_parsing_handles_spaces_and_parentheses_in_command_name() {
    val stat="101 (core (worker)) S "+(4..21).joinToString(" "){"0"}+" 700 0 0"
    assertEquals(700L,CoreProcessIdentity.fromProc(stat,"Uid:\t10123\t10123\t10123\t10123",command.joinToString("\u0000")+"\u0000")!!.startTicks)
    assertNull(CoreProcessIdentity.fromProc("broken","Uid: 10123","x"))
  }
}
