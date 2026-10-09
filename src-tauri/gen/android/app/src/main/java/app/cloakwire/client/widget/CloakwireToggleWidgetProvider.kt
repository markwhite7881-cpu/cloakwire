package app.cloakwire.client.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context

class CloakwireToggleWidgetProvider : AppWidgetProvider() {

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray
  ) {
    super.onUpdate(context, appWidgetManager, appWidgetIds)
    CloakwireWidgetUpdater.updateAllWidgets(context)
  }

  override fun onEnabled(context: Context) {
    super.onEnabled(context)
    CloakwireWidgetUpdater.updateAllWidgets(context)
  }
}
