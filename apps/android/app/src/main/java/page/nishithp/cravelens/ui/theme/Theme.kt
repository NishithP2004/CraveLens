package page.nishithp.cravelens.ui.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/** Brand accent. Filled controls use the seed primary so white labels stay readable. */
val Coral = Color(0xFFFF5B38)
val CoralDark = Color(0xFFB52605)
val Lime = Color(0xFFD9ED72)
val Ink = Color(0xFF201A19)

/**
 * Tonal-spot scheme from seed #FF5B38, generated with Material Color Utilities
 * (`Scheme.light` / `Scheme.dark`). Surface containers use the same neutral ramp.
 */
private val SeedLight = lightColorScheme(
    primary = Color(0xFFB52605),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFFDAD3),
    onPrimaryContainer = Color(0xFF3D0600),
    secondary = Color(0xFF77574F),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFFFDAD3),
    onSecondaryContainer = Color(0xFF2C1510),
    tertiary = Color(0xFF6E5D2E),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Lime,
    onTertiaryContainer = Ink,
    error = Color(0xFFBA1A1A),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    background = Color(0xFFFFF8F6),
    onBackground = Color(0xFF201A19),
    surface = Color(0xFFFFF8F6),
    onSurface = Color(0xFF201A19),
    surfaceVariant = Color(0xFFF5DDD8),
    onSurfaceVariant = Color(0xFF534340),
    outline = Color(0xFF85736F),
    outlineVariant = Color(0xFFD8C2BD),
    inverseSurface = Color(0xFF362F2D),
    inverseOnSurface = Color(0xFFFBEEEB),
    inversePrimary = Color(0xFFFFB4A4),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFEF1EE),
    surfaceContainer = Color(0xFFF8EBE8),
    surfaceContainerHigh = Color(0xFFF3E5E3),
    surfaceContainerHighest = Color(0xFFEDE0DD),
)

private val SeedDark = darkColorScheme(
    primary = Color(0xFFFFB4A4),
    onPrimary = Color(0xFF630E00),
    primaryContainer = Color(0xFF8C1800),
    onPrimaryContainer = Color(0xFFFFDAD3),
    secondary = Color(0xFFE7BDB4),
    onSecondary = Color(0xFF442A24),
    secondaryContainer = Color(0xFF5D3F39),
    onSecondaryContainer = Color(0xFFFFDAD3),
    tertiary = Lime,
    onTertiary = Ink,
    tertiaryContainer = Color(0xFF544519),
    onTertiaryContainer = Color(0xFFF8E0A6),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFB4AB),
    background = Color(0xFF201A19),
    onBackground = Color(0xFFEDE0DD),
    surface = Color(0xFF201A19),
    onSurface = Color(0xFFEDE0DD),
    surfaceVariant = Color(0xFF534340),
    onSurfaceVariant = Color(0xFFD8C2BD),
    outline = Color(0xFFA08C88),
    outlineVariant = Color(0xFF534340),
    inverseSurface = Color(0xFFEDE0DD),
    inverseOnSurface = Color(0xFF362F2D),
    inversePrimary = Color(0xFFB52605),
    surfaceContainerLowest = Color(0xFF120D0C),
    surfaceContainerLow = Color(0xFF201A19),
    surfaceContainer = Color(0xFF251E1D),
    surfaceContainerHigh = Color(0xFF2F2827),
    surfaceContainerHighest = Color(0xFF362F2D),
)

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun CraveTheme(mode: String, dynamicColor: Boolean = false, content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val dark = when (mode) {
        "light" -> false
        "dark" -> true
        else -> systemDark
    }
    val context = LocalContext.current
    val scheme = if (dynamicColor && Build.VERSION.SDK_INT >= 31) {
        if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else if (dark) SeedDark else SeedLight
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            val controller = WindowCompat.getInsetsController(window, view)
            controller.isAppearanceLightStatusBars = !dark
            controller.isAppearanceLightNavigationBars = !dark
        }
    }
    MaterialExpressiveTheme(
        colorScheme = scheme,
        motionScheme = MotionScheme.expressive(),
        typography = craveTypography(),
        content = content,
    )
}
