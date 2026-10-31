package app.cloakwire.client.vpn

import org.json.JSONObject
internal data class ProfileSource(val ref:ProfileRef,val revision:String){
 fun toJson():JSONObject=JSONObject().put("profile_ref",ref.toJson()).put("source_revision",revision)
 companion object{
  fun parse(raw:String):ProfileSource? {
   if(raw.isBlank())return null
   require(raw.length<=2048){"profile_source_changed"}
   val value=JSONObject(raw)
   val revision=value.getString("source_revision")
   require(Regex("[a-f0-9]{64}").matches(revision)){"profile_source_changed"}
   val ref=ProfileRef.fromJson(value.getJSONObject("profile_ref"))
   require(ref.toJson().toString().length<=1024 && ref !is ProfileRef.Auto){"profile_source_changed"}
   return ProfileSource(ref,revision)
  }
 }
}
internal data class ProfileCheckEvidence(val source:ProfileSource,val outcome:String,val checkedAt:Long,val error:String?=null,val context:String="stopped"){
 fun toJson():JSONObject=JSONObject().put("source",source.toJson()).put("kind","preflight")
  .put("error_context",context).put("outcome",outcome).put("checked_at",checkedAt).put("error",error?:JSONObject.NULL)
}
