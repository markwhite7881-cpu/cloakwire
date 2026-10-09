package app.cloakwire.client.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import app.cloakwire.client.R
import app.cloakwire.client.vpn.CloakwireVpnService
import app.cloakwire.client.vpn.VpnEvents

object CloakwireWidgetUpdater {

  private const val TAG = "CloakwireWidgetUpdater"
  private const val PREFS = "cloakwire_state"
  private const val KEY_LAST_SERVER = "last_server_name"
  private const val KEY_LAST_ENGINE = "last_engine"
  private const val KEY_ACCENT = "accent_theme"

  // Standard theme colors matching src/lib/accentTheme.ts
  private const val COLOR_EMERALD = 0xFF10B981.toInt()
  private const val COLOR_CYAN = 0xFF06B6D4.toInt()
  private const val COLOR_VIOLET = 0xFF8B5CF6.toInt()
  private const val COLOR_AMBER = 0xFFF59E0B.toInt()
  private const val COLOR_ROSE = 0xFFF43F5E.toInt()
  private const val COLOR_MUTED = 0xFF71717A.toInt()
  private const val COLOR_WHITE = 0xFFFFFFFF.toInt()
  private const val COLOR_BLUE = 0xFF38BDF8.toInt()

  fun resolveAccentColor(accentName: String?): Int {
    return when (accentName?.lowercase()) {
      "cyan" -> COLOR_CYAN
      "violet" -> COLOR_VIOLET
      "amber" -> COLOR_AMBER
      "rose" -> COLOR_ROSE
      "emerald" -> COLOR_EMERALD
      else -> COLOR_EMERALD
    }
  }

  /**
   * Pushes latest state and RemoteViews to all active widget instances.
   */
  fun updateAllWidgets(
    context: Context,
    optimisticConnecting: Boolean = false,
    optimisticDisconnecting: Boolean = false
  ) {
    val appWidgetManager = AppWidgetManager.getInstance(context) ?: return

    val isRunning: Boolean
    val isConnecting: Boolean

    if (optimisticDisconnecting) {
      isRunning = false
      isConnecting = false
    } else if (optimisticConnecting) {
      isRunning = false
      isConnecting = true
    } else {
      isRunning = VpnEvents.state == VpnEvents.STATE_RUNNING
      isConnecting = VpnEvents.state == VpnEvents.STATE_STARTING
    }

    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // Determine active server name
    val activeServer = CloakwireVpnService.activeServerName
    val serverName = if (activeServer.isNotBlank()) {
      activeServer
    } else {
      prefs.getString(KEY_LAST_SERVER, null)
        ?.takeIf { it.isNotBlank() } ?: "Cloakwire"
    }

    val accentName = prefs.getString(KEY_ACCENT, "emerald")
    val accentColor = resolveAccentColor(accentName)

    // Update Toggle Widgets
    try {
      val toggleComponent = ComponentName(context, CloakwireToggleWidgetProvider::class.java)
      val toggleIds = appWidgetManager.getAppWidgetIds(toggleComponent)
      if (toggleIds != null && toggleIds.isNotEmpty()) {
        val toggleViews = buildToggleViews(context, isRunning, isConnecting, optimisticDisconnecting, serverName, accentColor)
        appWidgetManager.updateAppWidget(toggleIds, toggleViews)
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed updating toggle widgets: ${e.message}")
    }
  }

  private fun buildToggleViews(
    context: Context,
    isRunning: Boolean,
    isConnecting: Boolean,
    isDisconnecting: Boolean,
    serverName: String,
    accentColor: Int
  ): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.widget_toggle)

    // Setup toggle button pending intent
    val toggleIntent = Intent(context, CloakwireWidgetReceiver::class.java).apply {
      action = CloakwireWidgetReceiver.ACTION_TOGGLE
    }
    val togglePending = PendingIntent.getBroadcast(
      context, 101, toggleIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    views.setOnClickPendingIntent(R.id.widget_btn_power, togglePending)

    // Setup app launch on info container click
    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    if (launchIntent != null) {
      val launchPending = PendingIntent.getActivity(
        context, 102, launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      views.setOnClickPendingIntent(R.id.widget_info_container, launchPending)
    }

    // Content & Styling
    views.setTextViewText(R.id.widget_text_server, serverName)

    when {
      isRunning -> {
        views.setTextViewText(R.id.widget_text_status, context.getString(R.string.widget_state_connected))
        views.setInt(R.id.widget_text_status, "setTextColor", accentColor)
        views.setInt(R.id.widget_dot_status, "setColorFilter", accentColor)
        views.setInt(R.id.widget_btn_power, "setColorFilter", accentColor)
      }
      isConnecting -> {
        views.setTextViewText(R.id.widget_text_status, context.getString(R.string.widget_state_connecting))
        views.setInt(R.id.widget_text_status, "setTextColor", COLOR_BLUE)
        views.setInt(R.id.widget_dot_status, "setColorFilter", COLOR_BLUE)
        views.setInt(R.id.widget_btn_power, "setColorFilter", COLOR_BLUE)
      }
      isDisconnecting -> {
        views.setTextViewText(R.id.widget_text_status, context.getString(R.string.widget_state_disconnecting))
        views.setInt(R.id.widget_text_status, "setTextColor", COLOR_MUTED)
        views.setInt(R.id.widget_dot_status, "setColorFilter", COLOR_MUTED)
        views.setInt(R.id.widget_btn_power, "setColorFilter", COLOR_MUTED)
      }
      else -> {
        views.setTextViewText(R.id.widget_text_status, context.getString(R.string.widget_state_disconnected))
        views.setInt(R.id.widget_text_status, "setTextColor", COLOR_MUTED)
        views.setInt(R.id.widget_dot_status, "setColorFilter", COLOR_MUTED)
        views.setInt(R.id.widget_btn_power, "setColorFilter", COLOR_WHITE)
      }
    }

    return views
  }
}
