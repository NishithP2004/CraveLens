package page.nishithp.cravelens.identify

import android.graphics.Bitmap
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import page.nishithp.cravelens.CraveLensApp
import page.nishithp.cravelens.capture.FrameStore
import page.nishithp.cravelens.core.routing.VisionAction
import page.nishithp.cravelens.core.routing.hostedFallbackOf
import page.nishithp.cravelens.core.routing.lassoVision
import page.nishithp.cravelens.core.routing.nanoStatusOf
import page.nishithp.cravelens.data.AppPrefs
import page.nishithp.cravelens.ui.BubbleStatus
import page.nishithp.cravelens.ui.WatchState
import page.nishithp.cravelens.ui.theme.Coral
import page.nishithp.cravelens.ui.theme.CraveTheme
import page.nishithp.cravelens.vision.AiLogicModels

class IdentifyActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val frame: Bitmap? = FrameStore.freezeLatest()
        var label by mutableStateOf(if (frame == null) "LASSO" else "IDENTIFYING")
        var headline by mutableStateOf(if (frame == null) "No frozen frame" else "Identifying…")
        var message by mutableStateOf(if (frame == null) "No frozen frame to identify." else "Identifying…")
        setContent {
            CraveTheme("system") {
                LaunchedEffect(frame) {
                    if (frame == null) return@LaunchedEffect
                    val outcome = withContext(Dispatchers.IO) { identifyFrame(frame) }
                    label = outcome.label
                    headline = outcome.headline
                    message = outcome.message
                }
                Column(Modifier.fillMaxWidth().padding(24.dp)) {
                    Text(label, color = Coral, style = MaterialTheme.typography.titleSmall)
                    Text(headline, style = MaterialTheme.typography.headlineMedium)
                    Text(message, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
    }

    private suspend fun identifyFrame(frame: Bitmap): IdentifyOutcome {
        val consent = hostedFallbackOf(AppPrefs.flow(this).first().hostedFallback)
        val models = AiLogicModels()
        val statusText = runCatching { models.status().toString() }.getOrElse { it.message ?: "unavailable" }
        val decision = lassoVision(consent, nanoStatusOf(statusText), CraveLensApp.appOnTop)
        return when (decision.action) {
            VisionAction.HOLD_FOR_TAP, VisionAction.ASK_CLOUD -> {
                WatchState.status = BubbleStatus.NEEDS_YOU
                WatchState.detail = "On-device model: $statusText"
                IdentifyOutcome("NEEDS YOU", "Choose cloud identification", "Gemini Nano is $statusText on this device. Cloud identification stays off until hosted fallback is auto, or you approve a cloud check.")
            }
            VisionAction.DROP, VisionAction.YOLO_ONLY -> {
                WatchState.status = BubbleStatus.NEEDS_YOU
                WatchState.detail = "On-device model: $statusText"
                IdentifyOutcome("ON-DEVICE", "On-device model unavailable", "Gemini Nano is $statusText on this device. Hosted fallback is off, so this frame was not sent to the cloud.")
            }
            VisionAction.HYBRID, VisionAction.NANO_ONLY, VisionAction.CLOUD_ONLY -> {
                val cloud = decision.action == VisionAction.CLOUD_ONLY
                val call = runCatching { models.identify(frame, "Identify the food.", decision.action) }
                call.fold(
                    onSuccess = {
                        WatchState.status = if (cloud) BubbleStatus.IDENTIFYING_CLOUD else BubbleStatus.IDENTIFYING_DEVICE
                        WatchState.detail = "Identifying · ${it.inferenceSource}"
                        IdentifyOutcome(
                            if (cloud) "CLOUD" else "ON-DEVICE",
                            if (cloud) "Identifying in the cloud…" else "Identifying on-device…",
                            it.text ?: "No text returned",
                        )
                    },
                    onFailure = {
                        WatchState.status = BubbleStatus.ERROR
                        WatchState.detail = "Error"
                        IdentifyOutcome("ERROR", "Identification failed", it.message ?: "Identification failed")
                    },
                )
            }
        }
    }
}

private data class IdentifyOutcome(val label: String, val headline: String, val message: String)
