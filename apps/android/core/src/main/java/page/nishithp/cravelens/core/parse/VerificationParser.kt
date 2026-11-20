package page.nishithp.cravelens.core.parse

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import page.nishithp.cravelens.core.model.FoodContext
import page.nishithp.cravelens.core.model.FoodDish
import page.nishithp.cravelens.core.model.FoodVerification

class VerificationParseException(message: String) : IllegalArgumentException(message)

private val parser = Json { ignoreUnknownKeys = true }

fun parseVerification(text: String): FoodVerification {
    val match = Regex("\\{[\\s\\S]*}").find(text) ?: throw VerificationParseException("The configured VLM did not return a JSON object")
    val value = try {
        parser.parseToJsonElement(match.value).jsonObject
    } catch (_: Exception) {
        throw VerificationParseException("The configured VLM did not return a JSON object")
    }
    val isFood = value["isFood"]?.jsonPrimitive?.booleanOrNull
    val dish = value["dish"]?.jsonPrimitive?.contentOrNull
    val context = value["context"]?.jsonPrimitive?.contentOrNull
    if (isFood == null || dish == null || context == null || context !in setOf("ready_to_eat", "recipe", "restaurant_experience")) {
        throw VerificationParseException("The configured VLM returned an invalid food result")
    }
    val dishes = value["dishes"] as? JsonArray
    if (dishes != null && dishes.size > 8) throw VerificationParseException("The configured VLM returned an invalid food result")
    return FoodVerification(
        isFood = isFood,
        dish = dish,
        description = value.string("description").trim().take(1200),
        cuisine = value["cuisine"]?.jsonPrimitive?.contentOrNull ?: "unknown",
        ingredients = value.strings("ingredients").take(20),
        confidence = (value["confidence"]?.jsonPrimitive?.doubleOrNull ?: 0.0).let { if (it.isNaN()) 0.0 else it }.coerceIn(0.0, 1.0),
        context = contextOf(context),
        dishes = dishes?.map { dishOf(it.jsonObject) } ?: emptyList(),
    )
}

private fun contextOf(raw: String) = when (raw) {
    "ready_to_eat" -> FoodContext.READY_TO_EAT
    "recipe" -> FoodContext.RECIPE
    else -> FoodContext.RESTAURANT_EXPERIENCE
}

private fun dishOf(value: JsonObject): FoodDish {
    val dish = value.string("dish").trim()
    if (dish.isEmpty() || dish.length > 200) throw VerificationParseException("The configured VLM returned an invalid food result")
    return FoodDish(
        dish = dish,
        description = value.string("description").trim().take(1200),
        cuisine = (value["cuisine"]?.jsonPrimitive?.contentOrNull ?: "unknown").take(200),
        ingredients = value.strings("ingredients").take(20),
        confidence = (value["confidence"]?.jsonPrimitive?.doubleOrNull ?: 0.0).coerceIn(0.0, 1.0),
    )
}

private fun JsonObject.string(key: String) = this[key]?.jsonPrimitive?.contentOrNull ?: ""

private fun JsonObject.strings(key: String): List<String> {
    val array = this[key] as? JsonArray ?: return emptyList()
    return array.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
}
