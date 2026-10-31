package app.cloakwire.client.vpn

import org.json.JSONArray
import org.json.JSONObject

internal data class CoreProcessIdentity(val pid:Int,val uid:Int,val startTicks:Long,val command:List<String>) {
  fun toJson()=JSONObject().put("pid",pid).put("uid",uid).put("start",startTicks).put("command",JSONArray(command))
  companion object {
    fun fromProc(stat:String,status:String,cmdline:String):CoreProcessIdentity?=runCatching {
      val end=stat.lastIndexOf(')')
      require(end>0)
      val fields=stat.substring(end+2).trim().split(Regex("\\s+"))
      val uid=status.lineSequence().first{it.startsWith("Uid:")}.substringAfter(':').trim().split(Regex("\\s+"))[0].toInt()
      CoreProcessIdentity(stat.substringBefore(' ').toInt(),uid,fields[19].toLong(),cmdline.split('\u0000').filter{it.isNotEmpty()})
    }.getOrNull()
    fun fromJson(j:JSONObject):CoreProcessIdentity {
      val a=j.getJSONArray("command")
      return CoreProcessIdentity(j.getInt("pid"),j.getInt("uid"),j.getLong("start"),(0 until a.length()).map{a.getString(it)})
    }
  }
}
internal data class OrphanLease(val owner:CoreProcessIdentity,val child:CoreProcessIdentity,val config:String) {
  fun canReap(observed:CoreProcessIdentity?,observedOwner:CoreProcessIdentity?,uid:Int,expectedConfig:String):Boolean =
    observed==child && owner.uid==uid && child.uid==uid && owner.pid!=child.pid &&
      config==expectedConfig && child.command.size==4 && child.command[0].endsWith("/libxray.so") &&
      child.command[1]=="run" && child.command[2]=="-c" && child.command[3]==config &&
      (observedOwner==null || observedOwner.uid!=owner.uid || observedOwner.startTicks!=owner.startTicks)
  fun toJson()=JSONObject().put("owner",owner.toJson()).put("child",child.toJson()).put("config",config)
  companion object {fun fromJson(j:JSONObject)=OrphanLease(CoreProcessIdentity.fromJson(j.getJSONObject("owner")),CoreProcessIdentity.fromJson(j.getJSONObject("child")),j.getString("config"))}
}
