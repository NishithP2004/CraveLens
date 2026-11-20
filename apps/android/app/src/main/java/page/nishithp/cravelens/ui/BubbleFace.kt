package page.nishithp.cravelens.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import page.nishithp.cravelens.ui.theme.Coral

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
fun BubbleFace(status: BubbleStatus, detail: String, modifier: Modifier = Modifier) {
    Row(modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(
            Modifier.size(56.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surface).border(3.dp, Coral, CircleShape),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("CL", color = Coral, style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.width(10.dp))
        Text(
            detail.ifBlank { status.label },
            modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(MaterialTheme.colorScheme.surface).padding(horizontal = 12.dp, vertical = 8.dp),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}
