package page.nishithp.cravelens.core.events

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

fun agentEventMessage(labels: JsonObject, event: String, details: JsonObject = JsonObject(emptyMap())): String? {
    if (event == "preferences_progress") return details.string("message").ifBlank { null }
    val tools = labels["tools"]?.jsonObject
    val tool = details.string("tool")
    val toolLabel = tools?.string(tool).orEmpty()
    return when (event) {
        "orchestration_started" -> "Preparing a ${details.string("dish").ifBlank { "food" }} cart"
        "orchestration_paused" -> "Another cart is active; review or reject it before preparing another"
        "orchestration_joined" -> "Using the ${details.string("dish").ifBlank { "food" }} cart build already in progress"
        "customization_started" -> "Understanding your requested changes"
        "started" -> "Personalization agent started"
        "tools_ready" -> "${details["count"]?.jsonPrimitive?.intOrNull ?: 0} Swiggy tools connected"
        "reasoning_started" -> "Planning the best cart for you"
        "model:fallback-required" -> "Waiting for approval before using a hosted model"
        "model:fallback-approved" -> {
            val automatic = details["automatic"]?.jsonPrimitive?.booleanOrNull == true
            val lead = if (automatic) "Automatically switched to a hosted model" else "Hosted fallback approved"
            "$lead · continuing with ${details.string("hostedProvider").ifBlank { "the configured provider" }}"
        }
        "metadata_retry" -> tools?.string("metadata_retry")?.ifBlank { null }
        "tool_call" -> toolLabel.ifBlank { "Using ${tool.ifBlank { "Swiggy" }}" }
        "tool_skipped" -> "Checking menu evidence before continuing"
        "tool_complete" -> toolLabel.takeIf { it.isNotBlank() }?.let { "$it · done" }
        "completed" -> "Cart research and personalization complete"
        "cart_ready" -> "Cart ready from ${details.string("restaurant").ifBlank { "Swiggy" }}"
        "failed", "tool_failed" -> details.string("error").ifBlank { "The cart agent hit an error" }
        else -> null
    }
}

fun hostedFallbackConfirm(template: String, provider: String, hostedProvider: String): String =
    template.replace("{provider}", provider).replace("{hostedProvider}", hostedProvider)

private fun JsonObject.string(key: String) = this[key]?.jsonPrimitive?.contentOrNull ?: ""
