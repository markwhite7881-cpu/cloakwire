package app.cloakwire.client.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.util.Log
import app.cloakwire.client.vpn.CloakwireVpnService
import app.cloakwire.client.vpn.VpnEvents

/**
 * Handles widget tap actions (power toggle button).
 * Directly communicates with [CloakwireVpnService] to start or stop the tunnel.
 */
class CloakwireWidgetReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_TOGGLE) return
    Log.i(TAG, "onReceive ACTION_TOGGLE, currentState=${VpnEvents.state}")

    val running = VpnEvents.state == VpnEvents.STATE_RUNNING || VpnEvents.state == VpnEvents.STATE_STARTING
    if (running) {
      val stopIntent = Intent(context, CloakwireVpnService::class.java).apply {
        action = CloakwireVpnService.ACTION_STOP
      }
      context.startService(stopIntent)
      // Optimistic UI update
      CloakwireWidgetUpdater.updateAllWidgets(context, optimisticConnecting = false, optimisticDisconnecting = true)
      return
    }

    // Not running: check VPN consent first
    if (VpnService.prepare(context) != null) {
      Log.i(TAG, "VPN consent required, launching main app")
      launchApp(context)
      return
    }

    // Check config file presence
    val configFile = CloakwireVpnService.configFile(context)
    if (!configFile.exists() || configFile.length() == 0L) {
      Log.i(TAG, "No config file found, launching main app")
      launchApp(context)
      return
    }

    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    var engine = prefs.getString(KEY_LAST_ENGINE, null)
    if (engine.isNullOrBlank()) {
      engine = if (configFile.name == "configuration.json" || configFile.name.contains("singbox")) {
        CloakwireVpnService.ENGINE_SINGBOX
      } else {
        CloakwireVpnService.ENGINE_XRAY
      }
    }
    val apps = prefs.getString(KEY_LAST_APPS, "[]") ?: "[]"
    val appsMode = prefs.getString(KEY_LAST_APPS_MODE, "exclude") ?: "exclude"
    val serverName = prefs.getString(KEY_LAST_SERVER, "") ?: ""

    val startIntent = Intent(context, CloakwireVpnService::class.java).apply {
      action = CloakwireVpnService.ACTION_START
      putExtra(CloakwireVpnService.EXTRA_CONFIG_PATH, configFile.absolutePath)
      putExtra(CloakwireVpnService.EXTRA_ENGINE, engine)
      putExtra(CloakwireVpnService.EXTRA_APPS, apps)
      putExtra(CloakwireVpnService.EXTRA_APPS_MODE, appsMode)
      putExtra(CloakwireVpnService.EXTRA_SERVER_NAME, serverName)
    }

    try {
      context.startForegroundService(startIntent)
      // Optimistic UI update
      CloakwireWidgetUpdater.updateAllWidgets(context, optimisticConnecting = true, optimisticDisconnecting = false)
    } catch (e: Exception) {
      Log.e(TAG, "startForegroundService failed: ${e.message}")
    }
  }

  private fun launchApp(context: Context) {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    try {
      context.startActivity(launch)
    } catch (e: Exception) {
      Log.e(TAG, "launchApp failed: ${e.message}")
    }
  }

  companion object {
    const val TAG = "CloakwireWidgetReceiver"
    const val ACTION_TOGGLE = "app.cloakwire.client.ACTION_WIDGET_TOGGLE"

    private const val PREFS = "cloakwire_state"
    private const val KEY_LAST_SERVER = "last_server_name"
    private const val KEY_LAST_ENGINE = "last_engine"
    private const val KEY_LAST_APPS = "last_apps"
    private const val KEY_LAST_APPS_MODE = "last_apps_mode"
  }
}
