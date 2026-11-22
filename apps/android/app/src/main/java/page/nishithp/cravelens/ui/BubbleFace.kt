package page.nishithp.cravelens.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.toPath
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.material3.toShape
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.graphics.shapes.Morph
import androidx.graphics.shapes.RoundedPolygon
import page.nishithp.cravelens.ui.theme.Coral
import page.nishithp.cravelens.ui.theme.Ink
import page.nishithp.cravelens.ui.theme.Lime
import page.nishithp.cravelens.ui.theme.Manrope
import kotlin.math.min

enum class BubbleStatus(val label: String) {
    OFF("Off"),
    WATCHING("Watching"),
    SPOTTED("Spotted food"),
    IDENTIFYING_DEVICE("Identifying · On-device"),
    IDENTIFYING_CLOUD("Identifying · Cloud"),
    PERSONALIZING("Personalizing"),
    PREPARING("Preparing cart"),
    READY("Cart ready"),
    NEEDS_YOU("Needs you"),
    PAUSED("Paused"),
    ERROR("Error"),
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
fun shapeFor(status: BubbleStatus): RoundedPolygon = when (status) {
    BubbleStatus.OFF -> MaterialShapes.Circle
    BubbleStatus.WATCHING -> MaterialShapes.Pill
    BubbleStatus.SPOTTED -> MaterialShapes.Cookie4Sided
    BubbleStatus.IDENTIFYING_DEVICE, BubbleStatus.IDENTIFYING_CLOUD -> MaterialShapes.Flower
    BubbleStatus.PERSONALIZING -> MaterialShapes.Clover4Leaf
    BubbleStatus.PREPARING -> MaterialShapes.Sunny
    BubbleStatus.READY -> MaterialShapes.Gem
    BubbleStatus.NEEDS_YOU -> MaterialShapes.Heart
    BubbleStatus.PAUSED -> MaterialShapes.Oval
    BubbleStatus.ERROR -> MaterialShapes.Burst
}

fun colorFor(status: BubbleStatus): Color = when (status) {
    BubbleStatus.OFF, BubbleStatus.PAUSED -> Color(0xFFE7D5D0)
    BubbleStatus.WATCHING, BubbleStatus.SPOTTED, BubbleStatus.PREPARING -> Coral
    BubbleStatus.PERSONALIZING, BubbleStatus.READY -> Lime
    BubbleStatus.IDENTIFYING_DEVICE, BubbleStatus.IDENTIFYING_CLOUD -> Color(0xFFFFB4A4)
    BubbleStatus.NEEDS_YOU -> Color(0xFFF8E0A6)
    BubbleStatus.ERROR -> Color(0xFFBA1A1A)
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun BubbleFace(status: BubbleStatus, detail: String, modifier: Modifier = Modifier) {
    val spoken = detail.ifBlank { status.label }
    val target = shapeFor(status)
    var from by remember { mutableStateOf(target) }
    val progress = remember { androidx.compose.animation.core.Animatable(1f) }
    val motion = MaterialTheme.motionScheme
    val spatial = motion.defaultSpatialSpec<Float>()
    LaunchedEffect(target) {
        if (from != target) {
            progress.snapTo(0f)
            progress.animateTo(1f, spatial)
            from = target
        }
    }
    val morph = remember(from, target) { Morph(from, target) }
    val fill by animateColorAsState(colorFor(status), motion.defaultEffectsSpec(), label = "bubble-fill")
    val wavy = status == BubbleStatus.PERSONALIZING || status == BubbleStatus.PREPARING
    Row(
        modifier.semantics { contentDescription = "CraveLens bubble, $spoken" }.padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(72.dp)
                .drawBehind {
                    val path = morph.toPath(progress.value)
                    val bounds = path.getBounds()
                    if (bounds.width <= 0f || bounds.height <= 0f) return@drawBehind
                    val scale = min(size.width / bounds.width, size.height / bounds.height) * 0.92f
                    translate(size.width / 2f, size.height / 2f) {
                        scale(scale, scale, pivot = Offset.Zero) {
                            translate(-bounds.center.x, -bounds.center.y) {
                                drawPath(path, fill)
                            }
                        }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            if (wavy) {
                LoadingIndicator(Modifier.size(36.dp), color = if (status == BubbleStatus.PERSONALIZING) Ink else Color.White)
            } else {
                Text("CL", color = if (fill == Lime) Ink else Color.White, fontFamily = Manrope, fontWeight = FontWeight.ExtraBold, style = MaterialTheme.typography.titleMedium)
            }
        }
        Spacer(Modifier.width(12.dp))
        Surface(shape = MaterialTheme.shapes.extraLarge, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Text(spoken, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp), style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** Static clip used by the overlay-less preview cards. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun StatusShape(status: BubbleStatus, modifier: Modifier = Modifier) {
    val shape = shapeFor(status).toShape()
    Box(modifier.clip(shape))
}
