package ru.classquiz.singbox.vpn

import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.VpnService
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log
import ru.classquiz.singbox.R

/**
 * Quick Settings tile for Cloakwire (added to the notification shade).
 * Mirrors the v2rayTun layout — a single round circular tile:
 *
 *   - inactive: Cloakwire hood icon, label "Cloakwire"
 *   - active:   Cloakwire hood icon with green Wi-Fi arcs, label = active server name
 *
 * The icon itself is the same drawable for both states — Android handles the
 * state distinction by tinting the tile's circular background button
 * (especially in monochrome / themed-icon mode on Android 13+).
 *
 * Tapping the tile toggles the VPN:
 *   - if running, sends ACTION_STOP to [CloakwireVpnService]
 *   - if not running, requires VPN consent first (open main activity
 *     so the user can grant it on first use), otherwise resumes the
 *     last session by reading the persisted engine config at
 *     [CloakwireVpnService.configFile] and passing it to the service
 *     as EXTRA_CONFIG_PATH (same path the JS side uses via VpnPlugin).
 *     If the config file is missing (no prior session, file was
 *     cleaned up, etc.), the tile falls back to opening the main
 *     activity so the user can pick a server.
 */
class QuickTileService : TileService() {

  private val tag = "CloakwireTile"
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun onStartListening() {
    super.onStartListening()
    refreshTile()
    // Some OEM SystemUI builds (the OnePlus/ColorOS tile host in
    // particular) render the tile before the first onStartListening
    // refresh is fully applied, so the panel can show the stale
    // state. A short delayed re-update re-applies the label/icon
    // after the host has committed the first paint.
    mainHandler.removeCallbacksAndMessages(null)
    mainHandler.postDelayed({ refreshTile() }, 250)
  }

  override fun onStopListening() {
    super.onStopListening()
    // Cancel any pending re-update — the tile is about to be
    // detached and the next onStartListening will schedule its own.
    mainHandler.removeCallbacksAndMessages(null)
  }

  override fun onClick() {
    super.onClick()
    val running = VpnEvents.state == VpnEvents.STATE_RUNNING
    Log.i(tag, "click: state=${VpnEvents.state} running=$running")
    if (running) {
      val intent = Intent(this, CloakwireVpnService::class.java)
        .setAction(CloakwireVpnService.ACTION_STOP)
      startService(intent)
      // Optimistic UI: the next refresh tick will pick up the real
      // state, but flipping the icon immediately feels much snappier.
      qsTile?.let {
        it.label = "Cloakwire"
        it.icon = Icon.createWithResource(this, R.drawable.ic_tile)
        it.state = Tile.STATE_INACTIVE
        it.updateTile()
      }
      return
    }
    // No consent yet? Open the app so the user can grant it.
    if (VpnService.prepare(this) != null) {
      launchApp()
      return
    }
    // No persisted engine config? Open the app so the user can pick a
    // server — the tile intentionally only resumes an existing
    // session, it never picks a new one.
    val configFile = CloakwireVpnService.configFile(this)
    if (!configFile.exists()) {
      launchApp()
      return
    }
    val intent = Intent(this, CloakwireVpnService::class.java)
      .setAction(CloakwireVpnService.ACTION_START)
      .putExtra(CloakwireVpnService.EXTRA_CONFIG_PATH, configFile.absolutePath)
    try {
      startForegroundService(intent)
      // Optimistic UI: pretend we're connecting so the tile doesn't
      // look dead for the ~1s it takes the service to start.
      qsTile?.let {
        it.label = "Cloakwire"
        it.icon = Icon.createWithResource(this, R.drawable.ic_tile)
        it.state = Tile.STATE_ACTIVE
        it.updateTile()
      }
    } catch (e: Exception) {
      Log.e(tag, "startForegroundService failed: ${e.message}")
    }
  }

  private fun launchApp() {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    startActivityAndCollapse(launch)
  }

  private fun refreshTile() {
    val tile = qsTile ?: return
    val running = VpnEvents.state == VpnEvents.STATE_RUNNING
    // Active session name wins; if the service isn't running we still
    // show the last persisted name so the label doesn't collapse to
    // "Cloakwire" right after the first ever connect.
    val active = CloakwireVpnService.activeServerName
    val server: String? = if (active.isNotBlank()) {
      active
    } else {
      getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getString(KEY_LAST_SERVER, null)
    }
    if (running) {
      tile.label = server?.takeIf { it.isNotBlank() } ?: "Cloakwire"
      tile.icon = Icon.createWithResource(this, R.drawable.ic_tile)
      tile.state = Tile.STATE_ACTIVE
    } else {
      tile.label = "Cloakwire"
      tile.icon = Icon.createWithResource(this, R.drawable.ic_tile)
      tile.state = Tile.STATE_INACTIVE
    }
    tile.updateTile()
  }

  companion object {
    private const val PREFS = "cloakwire_state"
    private const val KEY_LAST_SERVER = "last_server_name"

    /**
     * Asks the system to invoke [onStartListening] on the currently-
     * listening tile so it re-binds to the latest state. Called from
     * [CloakwireVpnService] (via the VpnEvents state-change listener)
     * on every VPN state transition. Safe to call when the tile is
     * not added — the system silently ignores it.
     *
     * We post via the main looper because some OEM SystemUI builds
     * ignore `requestListeningState` when it's invoked from a
     * background thread.
     */
    fun notifyStateChanged(context: Context) {
      val mainHandler = Handler(Looper.getMainLooper())
      mainHandler.post {
        try {
          TileService.requestListeningState(
            context,
            android.content.ComponentName(context, QuickTileService::class.java),
          )
        } catch (e: Exception) {
          Log.w("CloakwireTile", "notifyStateChanged: ${e.message}")
        }
      }
    }
  }
}
