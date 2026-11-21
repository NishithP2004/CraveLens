package page.nishithp.cravelens.agent

import page.nishithp.cravelens.core.agent.InferenceException
import page.nishithp.cravelens.core.model.InferenceRequest
import page.nishithp.cravelens.core.model.InferenceResult
import java.io.File

class LiteRtLmChat(private val modelFile: File?) {
    val ready: Boolean get() = modelFile?.isFile == true && modelFile.length() > 0L

    fun run(request: InferenceRequest): InferenceResult {
        if (!ready) throw InferenceException("INFERENCE_UNAVAILABLE", "LiteRT Gemma is not downloaded on this device")
        throw InferenceException("INFERENCE_UNAVAILABLE", "LiteRT-LM engine is not linked in this build; the model file is present but was not executed")
    }
}
