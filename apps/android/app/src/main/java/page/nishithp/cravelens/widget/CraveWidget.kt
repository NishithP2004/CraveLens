package page.nishithp.cravelens.widget

import android.content.Context
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import kotlinx.coroutines.flow.first
import page.nishithp.cravelens.craveApi
import page.nishithp.cravelens.data.AppPrefs

class CraveWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val api = context.craveApi()
        val prefs = AppPrefs.flow(context).first()
        val summary = if (api.baseUrl.isBlank()) "No cart yet." else prefs.cartSummary
        provideContent {
            Column(GlanceModifier.fillMaxSize().background(ColorProvider(Color(0xFFFFF8F6))).padding(12.dp)) {
                Text("CraveLens", style = TextStyle(color = ColorProvider(Color(0xFFB52605)), fontWeight = FontWeight.Bold))
                Text(prefs.watchLabel, style = TextStyle(color = ColorProvider(Color(0xFF201A19))))
                Text(summary, style = TextStyle(color = ColorProvider(Color(0xFF534340))), maxLines = 3)
            }
        }
    }
}

class CraveWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = CraveWidget()
}

suspend fun refreshWidget(context: Context) {
    CraveWidget().updateAll(context)
}
