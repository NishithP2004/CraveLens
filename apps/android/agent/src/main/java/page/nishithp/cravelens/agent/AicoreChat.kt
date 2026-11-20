package page.nishithp.cravelens.agent

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.FunctionArgValue
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.schema.tools.FunctionDeclaration
import com.google.mlkit.genai.schema.tools.FunctionSchema
import com.google.mlkit.genai.schema.tools.FunctionType
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import page.nishithp.cravelens.core.agent.InferenceException
import page.nishithp.cravelens.core.agent.liteRtToolPolicy
import page.nishithp.cravelens.core.agent.mapToolSchema
import page.nishithp.cravelens.core.agent.repairToolName
import page.nishithp.cravelens.core.model.InferenceRequest
import page.nishithp.cravelens.core.model.InferenceResult
import page.nishithp.cravelens.core.model.InferenceToolCall

class AicoreChat {
    suspend fun checkReady(): Boolean = try {
        Generation.getClient().checkStatus() == FeatureStatus.AVAILABLE
    } catch (_: Throwable) {
        false
    }

    suspend fun run(request: InferenceRequest): InferenceResult {
        val started = System.currentTimeMillis()
        val policy = liteRtToolPolicy(request)
        val declarations = policy.tools.map { declaration(mapToolSchema(it)) }
        val prompt = buildString {
            request.messages.forEach { message ->
                append(message.role.uppercase())
                append(": ")
                append(message.content)
                message.toolCalls?.forEach { call ->
                    append("\nCALL ")
                    append(call.name)
                    append(' ')
                    append(call.args)
                }
                append('\n')
            }
            if (policy.instruction.isNotBlank()) append("\n").append(policy.instruction)
        }
        val base = GenerateContentRequest.Builder(TextPart(prompt)).apply {
            if (declarations.isNotEmpty()) setTools(declarations)
        }.build()
        val response = Generation.getClient().generateContent(base)
        val calls = response.candidates.firstOrNull()?.functionCalls.orEmpty()
        val allowed = policy.tools.map { mapToolSchema(it).name }.toSet()
        var repairs = 0
        val toolCalls = calls.map { call ->
            val repaired = repairToolName(call.name, allowed) ?: throw InferenceException("INFERENCE_INVALID_TOOL_CALL", "Local model called a tool outside the current allowed tool set")
            if (repaired != call.name) repairs += 1
            InferenceToolCall(call.id.orEmpty().ifBlank { java.util.UUID.randomUUID().toString() }, repaired, argsOf(call.arguments))
        }
        val text = response.candidates.firstOrNull()?.text.orEmpty()
        val finish = when {
            toolCalls.isNotEmpty() -> "tool_calls"
            policy.required -> "missing_required_tool_call"
            else -> "stop"
        }
        return InferenceResult(
            requestId = request.requestId,
            content = text,
            toolCalls = toolCalls,
            finishReason = finish,
            metrics = buildJsonObject {
                put("runtime", JsonPrimitive("aicore"))
                put("model", JsonPrimitive(request.model))
                put("latencyMs", JsonPrimitive(System.currentTimeMillis() - started))
                put("nearMissRepairs", JsonPrimitive(repairs))
                put("thinking", JsonPrimitive(if (request.options.thinkingEnabled) 1 else 0))
            },
        )
    }

    private fun declaration(tool: page.nishithp.cravelens.core.agent.MappedTool) = FunctionDeclaration(
        name = tool.name,
        description = tool.description,
        parameters = schema(tool.parameters),
    )

    private fun schema(value: JsonObject): FunctionSchema {
        val type = when (value["type"]?.jsonPrimitive?.contentOrNull) {
            "string" -> FunctionType.STRING
            "integer" -> FunctionType.INTEGER
            "number" -> FunctionType.NUMBER
            "boolean" -> FunctionType.BOOLEAN
            "array" -> FunctionType.ARRAY
            else -> FunctionType.OBJECT
        }
        val properties = value["properties"]?.jsonObject?.mapValues { (_, child) -> schema(child.jsonObject) }.orEmpty()
        val required = value["required"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty()
        val items = value["items"]?.jsonObject?.let { schema(it) }
        return FunctionSchema(type = type, properties = properties, required = required, items = items, description = value["description"]?.jsonPrimitive?.contentOrNull)
    }

    private fun argsOf(args: Map<String, FunctionArgValue>): JsonObject = buildJsonObject {
        args.forEach { (key, value) -> put(key, argJson(value)) }
    }

    private fun argJson(value: FunctionArgValue): JsonElement = when (value) {
        is FunctionArgValue.StringValue -> JsonPrimitive(value.value)
        is FunctionArgValue.BoolValue -> JsonPrimitive(value.value)
        is FunctionArgValue.IntValue -> JsonPrimitive(value.value)
        is FunctionArgValue.LongValue -> JsonPrimitive(value.value)
        is FunctionArgValue.DoubleValue -> JsonPrimitive(value.value)
        is FunctionArgValue.ListValue -> JsonArray(value.values.map { argJson(it) })
        is FunctionArgValue.MapValue -> buildJsonObject { value.map.forEach { (key, child) -> put(key, argJson(child)) } }
        else -> JsonPrimitive(value.toString())
    }
}
