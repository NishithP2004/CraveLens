package page.nishithp.cravelens.core.agent

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import page.nishithp.cravelens.core.model.InferenceMessage
import page.nishithp.cravelens.core.model.InferenceRequest

class InferenceException(val code: String, message: String) : IllegalStateException(message)

data class ToolPolicy(val tools: List<JsonObject>, val required: Boolean, val instruction: String)

fun toolName(tool: JsonObject): String =
    tool["function"]?.jsonObject?.get("name")?.jsonPrimitive?.contentOrNull
        ?: tool["name"]?.jsonPrimitive?.contentOrNull
        ?: ""

fun liteRtToolPolicy(request: InferenceRequest): ToolPolicy {
    val choice = request.options.toolChoice
    val tools = request.tools
    val name = when {
        choice == null -> null
        choice is kotlinx.serialization.json.JsonPrimitive && choice.isString -> null
        choice is kotlinx.serialization.json.JsonObject -> choice["function"]?.jsonObject?.get("name")?.jsonPrimitive?.contentOrNull
            ?: choice["name"]?.jsonPrimitive?.contentOrNull
        else -> null
    }
    val choiceName = choice?.let { if (it is kotlinx.serialization.json.JsonPrimitive && it.isString) it.content else null }
    if (name != null && tools.none { toolName(it) == name }) {
        throw InferenceException("INFERENCE_INVALID_TOOL_CALL", "Required tool $name is unavailable")
    }
    val selected = when {
        choiceName == "none" -> emptyList()
        name != null -> tools.filter { toolName(it) == name }
        else -> tools
    }
    val instruction = when {
        choiceName == "none" -> "CURRENT TURN: Return the final answer without calling tools."
        name != null -> "CURRENT TURN: Invoke exactly the $name tool using its declared schema. Do not respond with prose."
        choiceName == "required" -> "CURRENT TURN: Invoke an appropriate provided tool using its declared schema. Do not respond with prose. Copy identifiers from returned menu evidence using their declared field names and types."
        else -> ""
    }
    return ToolPolicy(selected, choiceName == "required" || name != null, instruction)
}

fun trimOldestExchange(messages: List<InferenceMessage>): List<InferenceMessage>? {
    if (messages.size < 3) return null
    val protected = mutableSetOf<Int>()
    val firstUser = messages.indexOfFirst { it.role == "user" }
    val lastUser = messages.indexOfLast { it.role == "user" }
    messages.forEachIndexed { index, message ->
        if (message.role == "system" || index == firstUser || index == lastUser) protected += index
    }
    for (names in listOf(setOf("search_menu", "get_restaurant_menu"), setOf("update_food_cart"))) {
        for (index in messages.indices.reversed()) {
            val message = messages[index]
            if (message.role == "tool" && names.contains(message.name)) {
                protected += index
                if (index > 0) protected += index - 1
                break
            }
        }
    }
    protected += messages.lastIndex
    if (messages.last().role == "tool" && messages.size > 1) protected += messages.lastIndex - 1
    var index = 0
    while (index < messages.size) {
        if (protected.contains(index) || messages[index].role == "tool") {
            index += 1
            continue
        }
        var end = index + 1
        while (end < messages.size && messages[end].role == "tool") end += 1
        if ((index until end).any { protected.contains(it) }) {
            index = end
            continue
        }
        return messages.subList(0, index) + messages.subList(end, messages.size)
    }
    return null
}

fun repairToolName(name: String, allowed: Set<String>): String? {
    if (name in allowed) return name
    val candidates = allowed.filter { editDistance(it, name) <= 2 }
    return candidates.singleOrNull()
}

fun editDistance(left: String, right: String): Int {
    val row = IntArray(right.length + 1) { it }
    for (i in left.indices) {
        var previous = row[0]
        row[0] = i + 1
        for (j in right.indices) {
            val current = row[j + 1]
            val cost = if (left[i] == right[j]) 0 else 1
            row[j + 1] = minOf(row[j + 1] + 1, row[j] + 1, previous + cost)
            previous = current
        }
    }
    return row[right.length]
}

data class MappedTool(val name: String, val description: String, val parameters: JsonObject)

fun mapToolSchema(tool: JsonObject): MappedTool {
    val function = tool["function"]?.jsonObject ?: tool
    val parameters = function["parameters"]?.jsonObject ?: JsonObject(emptyMap())
    rejectUnsupported(parameters)
    return MappedTool(
        name = function["name"]?.jsonPrimitive?.content ?: throw InferenceException("INFERENCE_INVALID_HISTORY", "Tool is missing a name"),
        description = function["description"]?.jsonPrimitive?.contentOrNull ?: "",
        parameters = parameters,
    )
}

private fun rejectUnsupported(schema: JsonObject) {
    if (schema.containsKey("anyOf") || schema.containsKey("oneOf") || schema.containsKey("allOf")) {
        throw InferenceException("INFERENCE_INVALID_HISTORY", "Tool schema uses a combinator Nano cannot represent")
    }
    schema["properties"]?.jsonObject?.values?.forEach { value ->
        if (value is JsonObject) rejectUnsupported(value)
    }
    val items = schema["items"]
    if (items is JsonObject) rejectUnsupported(items)
}
