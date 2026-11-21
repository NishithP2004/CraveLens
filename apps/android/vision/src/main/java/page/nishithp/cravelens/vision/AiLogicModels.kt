package page.nishithp.cravelens.vision

import android.graphics.Bitmap
import com.google.firebase.Firebase
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.PublicPreviewAPI
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import com.google.firebase.ai.InferenceMode
import com.google.firebase.ai.OnDeviceConfig
import com.google.firebase.ai.OnDeviceModelOption
import com.google.firebase.ai.ondevice.FirebaseAIOnDevice
import com.google.firebase.ai.ondevice.OnDeviceModelStatus
import page.nishithp.cravelens.core.parse.parseVerification
import page.nishithp.cravelens.core.routing.VisionAction

data class VisionCall(
    val text: String?,
    val inferenceSource: String,
    val error: String? = null,
)

@OptIn(PublicPreviewAPI::class)
class AiLogicModels(private val cloudModel: String = "gemini-3.5-flash-lite") {
    private val ai by lazy { Firebase.ai(backend = GenerativeBackend.googleAI()) }

    suspend fun status(): OnDeviceModelStatus = FirebaseAIOnDevice.checkStatus()

    fun model(action: VisionAction) = ai.generativeModel(
        modelName = cloudModel,
        generationConfig = generationConfig {
            temperature = 0.1f
            responseMimeType = "application/json"
        },
        onDeviceConfig = OnDeviceConfig(
            mode = when (action) {
                VisionAction.HYBRID -> InferenceMode.PREFER_ON_DEVICE
                VisionAction.CLOUD_ONLY -> InferenceMode.ONLY_IN_CLOUD
                else -> InferenceMode.ONLY_ON_DEVICE
            },
            maxOutputTokens = 384,
            temperature = 0.1f,
            modelOption = OnDeviceModelOption.STABLE,
        ),
    )

    suspend fun identify(bitmap: Bitmap, prompt: String, action: VisionAction): VisionCall {
        val response = model(action).generateContent(content {
            image(bitmap)
            text(prompt)
        })
        val source = response.inferenceSource.toString()
        return VisionCall(response.text, source)
    }

    fun parse(text: String) = parseVerification(text)
}
