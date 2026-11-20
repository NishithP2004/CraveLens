package page.nishithp.cravelens.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Coral = Color(0xFFFF5B38)
val CoralDark = Color(0xFFEC4525)
val Ink = Color(0xFF181814)
val Cream = Color(0xFFF7F1E7)
val Paper = Color(0xFFFFFAF2)
val Muted = Color(0xFF716F65)
val Night = Color(0xFF10110E)
val NightPaper = Color(0xFF1C1D18)
val NightInk = Color(0xFFFFF8EE)

private val Light = lightColorScheme(primary = Coral, onPrimary = Color.White, background = Cream, surface = Paper, onBackground = Ink, onSurface = Ink, secondary = Ink)
private val Dark = darkColorScheme(primary = Coral, onPrimary = Color.White, background = Night, surface = NightPaper, onBackground = NightInk, onSurface = NightInk, secondary = NightInk)

@Composable
fun CraveTheme(mode: String, content: @Composable () -> Unit) {
    val dark = when (mode) {
        "light" -> false
        "dark" -> true
        else -> isSystemInDarkTheme()
    }
    MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
}
