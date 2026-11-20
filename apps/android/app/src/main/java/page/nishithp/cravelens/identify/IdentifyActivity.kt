package page.nishithp.cravelens.identify

import android.graphics.Bitmap
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import page.nishithp.cravelens.capture.FrameStore
import page.nishithp.cravelens.ui.BubbleStatus
import page.nishithp.cravelens.ui.theme.CraveTheme
import page.nishithp.cravelens.ui.WatchState
import page.nishithp.cravelens.vision.AiLogicModels

class IdentifyActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val frame: Bitmap? = FrameStore.freezeLatest()
        var message by mutableStateOf(if (frame == null) "No frozen frame to identify." else "Identifying on-device…")
        setContent {
            CraveTheme("system") {
                LaunchedEffect(frame) {
                    if (frame == null) return@LaunchedEffect
                    message = withContext(Dispatchers.IO) {
                        val models = AiLogicModels()
                        val status = runCatching { models.status().toString() }.getOrElse { it.message ?: "unavailable" }
                        if (status != "AVAILABLE") {
                            WatchState.status = BubbleStatus.NEEDS_YOU
                            WatchState.detail = "On-device model: $status"
                            return@withContext "Gemini Nano is $status on this device. Cloud identification stays off unless you choose it."
                        }
                        val call = runCatching { models.identify(frame, "Identify the food.", page.nishithp.cravelens.core.routing.VisionAction.NANO_ONLY) }
                        call.fold(
                            onSuccess = {
                                WatchState.status = BubbleStatus.IDENTIFYING_DEVICE
                                WatchState.detail = "Identifying · ${it.inferenceSource}"
                                it.text ?: "No text returned"
                            },
                            onFailure = {
                                WatchState.status = BubbleStatus.ERROR
                                WatchState.detail = "Error"
                                it.message ?: "Identification failed"
                            },
                        )
                    }
                }
                Column(Modifier.fillMaxWidth().padding(24.dp)) {
                    Text("Identifying on-device…")
                    Text(message)
                }
            }
        }
    }
}
