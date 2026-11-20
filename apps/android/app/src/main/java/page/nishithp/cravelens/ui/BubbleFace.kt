package page.nishithp.cravelens.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import page.nishithp.cravelens.ui.theme.Coral
import page.nishithp.cravelens.ui.theme.Lime
import page.nishithp.cravelens.ui.theme.Manrope
import androidx.compose.ui.text.font.FontWeight

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

@Composable
fun BubbleFace(status: BubbleStatus, detail: String, modifier: Modifier = Modifier, pulse: Boolean = true) {
    val spoken = detail.ifBlank { status.label }
    val transition = rememberInfiniteTransition(label = "bubble-pulse")
    val scale by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (pulse && status != BubbleStatus.OFF) 1.06f else 1f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "bubble-scale",
    )
    Row(
        modifier.semantics { contentDescription = "CraveLens bubble, $spoken" }.padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Box(Modifier.size(68.dp).scale(scale).clip(CircleShape).border(3.dp, Coral, CircleShape))
            Column(
                Modifier.size(54.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surface).border(2.dp, Lime, CircleShape),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("CL", color = Coral, fontFamily = Manrope, fontWeight = FontWeight.ExtraBold, style = MaterialTheme.typography.titleMedium)
            }
        }
        Spacer(Modifier.width(12.dp))
        AnimatedContent(targetState = spoken, transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(160)) }, label = "bubble-label") { label ->
            Text(
                label,
                modifier = Modifier.clip(RoundedCornerShape(99.dp)).background(MaterialTheme.colorScheme.surface).border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(99.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}
