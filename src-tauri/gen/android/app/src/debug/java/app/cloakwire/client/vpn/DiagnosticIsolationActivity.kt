package app.cloakwire.client.vpn

import android.app.Activity
import android.os.*
import android.content.*
import java.io.File

/** Shell-only driver, in its own process so killing the Binder client cannot kill the VPN. */
class DiagnosticIsolationActivity : Activity() {
  private var remote:Messenger?=null
  private var bound=false
  private var terminal=false
  private var mode="hold"
  private val replies=Messenger(Handler(Looper.getMainLooper()) { message ->
    val json=message.data.getString("result") ?: return@Handler true
    File(filesDir,"diagnostics-isolation-result.json").writeText(json)
    val state=org.json.JSONObject(json).optString("state")
    if(state!="ready") { terminal=true;detach();finish() }
    true
  })
  private val connection=object:ServiceConnection {
    override fun onServiceConnected(name:ComponentName,binder:IBinder) {remote=Messenger(binder);send()}
    override fun onServiceDisconnected(name:ComponentName) {
      remote=null
      if(!terminal)File(filesDir,"diagnostics-isolation-result.json").writeText("""{"state":"crashed"}""")
      terminal=true;detach();finish()
    }
  }
  override fun onCreate(state:Bundle?) {
    super.onCreate(state)
    mode=intent.getStringExtra("mode")?:"hold"
    bound=bindService(Intent(this,DiagnosticIsolationService::class.java),connection,BIND_AUTO_CREATE)
    if(!bound) {File(filesDir,"diagnostics-isolation-result.json").writeText("""{"state":"failed","stage":"bind"}""");finish()}
  }
  override fun onNewIntent(intent:Intent) {super.onNewIntent(intent);setIntent(intent);mode=intent.getStringExtra("mode")?:"hold";send()}
  private fun send() {
    remote?.send(Message.obtain(null,1).apply {replyTo=replies;data=Bundle().apply {putString("mode",mode);putInt("fixturePort",intent.getIntExtra("fixturePort",0))}})
  }
  private fun detach() {if(bound){bound=false;runCatching {unbindService(connection)}}}
  override fun onDestroy(){detach();super.onDestroy()}
}
