package page.nishithp.cravelens.agent

import com.google.firebase.Firebase
import com.google.firebase.ai.InferenceMode
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.OnDeviceConfig
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.FunctionDeclaration
import com.google.firebase.ai.type.PublicPreviewAPI
import com.google.firebase.ai.type.Tool
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import page.nishithp.cravelens.core.agent.liteRtToolPolicy
import page.nishithp.cravelens.core.agent.mapToolSchema
import page.nishithp.cravelens.core.model.InferenceRequest
import page.nishithp.cravelens.core.model.InferenceResult
import page.nishithp.cravelens.core.model.InferenceToolCall

@OptIn(PublicPreviewAPI::class)
class FirebaseCloudChat(private val modelName: String = "gemini-3.5-flash") {
    suspend fun run(request: InferenceRequest): InferenceResult {
        val started = System.currentTimeMillis()
        val policy = liteRtToolPolicy(request)
        val declarations = policy.tools.map { tool ->
            val mapped = mapToolSchema(tool)
            FunctionDeclaration(mapped.name, mapped.description, emptyMap())
        }
        val model = Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
            modelName = modelName,
            generationConfig = generationConfig { temperature = 0.2f },
            tools = if (declarations.isEmpty()) emptyList() else listOf(Tool.functionDeclarations(declarations)),
            onDeviceConfig = OnDeviceConfig(mode = InferenceMode.ONLY_IN_CLOUD),
        )
        val prompt = request.messages.joinToString("\n") { "${it.role}: ${it.content}" } +
            if (policy.instruction.isBlank()) "" else "\n${policy.instruction}"
        val response = model.generateContent(content { text(prompt) })
        val calls = response.functionCalls.orEmpty().map {
            InferenceToolCall(java.util.UUID.randomUUID().toString(), it.name, JsonObject(emptyMap()))
        }
        return InferenceResult(
            requestId = request.requestId,
            content = response.text.orEmpty(),
            toolCalls = calls,
            finishReason = if (calls.isEmpty()) "stop" else "tool_calls",
            metrics = buildJsonObject {
                put("runtime", JsonPrimitive("firebase-cloud"))
                put("model", JsonPrimitive(modelName))
                put("latencyMs", JsonPrimitive(System.currentTimeMillis() - started))
            },
        )
    }
}
