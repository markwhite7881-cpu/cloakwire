package app.cloakwire.client.widget

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetAccentPaletteTest {
  @Test fun resolvesNewAccentColorsAndKeepsTheFallback() {
    val colors = mapOf(
      "azure" to 0xFF38BDF8.toInt(), "indigo" to 0xFF818CF8.toInt(),
      "coral" to 0xFFFB806B.toInt(), "lime" to 0xFFA3E635.toInt(),
      "fuchsia" to 0xFFE879F9.toInt(), "slate" to 0xFF94A3B8.toInt()
    )
    colors.forEach { (name, color) -> assertEquals(color, CloakwireWidgetUpdater.resolveAccentColor(name)) }
    assertEquals(0xFF10B981.toInt(), CloakwireWidgetUpdater.resolveAccentColor(null))
  }
}
