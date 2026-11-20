package page.nishithp.cravelens.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

val Coral = Color(0xFFFF5B38)
val CoralDark = Color(0xFFEC4525)
val Lime = Color(0xFFD9ED72)
val Ink = Color(0xFF181814)
val Cream = Color(0xFFF7F1E7)
val Paper = Color(0xFFFFFAF2)
val Muted = Color(0xFF716F65)
val Line = Color(0xFFD9D1C2)
val Body = Color(0xFF555349)
val Success = Color(0xFF3C702E)
val Night = Color(0xFF10110E)
val NightPaper = Color(0xFF1C1D18)
val NightInk = Color(0xFFFFF8EE)
val NightMuted = Color(0xFFB6B2A7)
val NightLine = Color(0xFF3E4036)
val NightBody = Color(0xFFC7C3B8)
val NightSoft = Color(0xFF24261F)
val NightSuccess = Color(0xFFA9D28D)
val Peach = Color(0xFFFFE1D5)

private val LightColors = lightColorScheme(
    primary = Coral,
    onPrimary = Color.White,
    primaryContainer = Peach,
    onPrimaryContainer = Ink,
    secondary = Lime,
    onSecondary = Ink,
    background = Cream,
    onBackground = Ink,
    surface = Paper,
    onSurface = Ink,
    surfaceVariant = Color(0xFFEEE7DC),
    onSurfaceVariant = Muted,
    outline = Line,
    error = Color(0xFFB84423),
    onError = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = Coral,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF38251E),
    onPrimaryContainer = NightInk,
    secondary = Lime,
    onSecondary = Ink,
    background = Night,
    onBackground = NightInk,
    surface = NightPaper,
    onSurface = NightInk,
    surfaceVariant = NightSoft,
    onSurfaceVariant = NightMuted,
    outline = NightLine,
    error = Color(0xFFFFAD7B),
    onError = Ink,
)

private val CraveShapes = Shapes(
    extraSmall = androidx.compose.foundation.shape.RoundedCornerShape(9.dp),
    small = androidx.compose.foundation.shape.RoundedCornerShape(13.dp),
    medium = androidx.compose.foundation.shape.RoundedCornerShape(20.dp),
    large = androidx.compose.foundation.shape.RoundedCornerShape(26.dp),
    extraLarge = androidx.compose.foundation.shape.RoundedCornerShape(36.dp),
)

@Composable
fun CraveTheme(mode: String, content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val dark = when (mode) {
        "light" -> false
        "dark" -> true
        else -> systemDark
    }
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            val controller = WindowCompat.getInsetsController(window, view)
            controller.isAppearanceLightStatusBars = false
            controller.isAppearanceLightNavigationBars = !dark
        }
    }
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        typography = craveTypography(),
        shapes = CraveShapes,
        content = content,
    )
}
