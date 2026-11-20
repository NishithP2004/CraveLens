package page.nishithp.cravelens.core.identity

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import page.nishithp.cravelens.core.json.CraveJson

@Serializable
data class DishIdentity(val dish: String, val cuisine: String, val ingredients: List<String>)

@Serializable
data class CravingIdentity(val primary: DishIdentity, val dishes: List<DishIdentity>)

fun normalizeIdentity(value: String?): String =
    (value ?: "").lowercase().replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()

fun foodCravingIdentity(food: Map<String, Any?>): CravingIdentity {
    fun identity(item: Map<*, *>): DishIdentity {
        val ingredients = (item["ingredients"] as? List<*>)?.map { normalizeIdentity(it?.toString()) }?.sorted().orEmpty()
        return DishIdentity(normalizeIdentity(item["dish"]?.toString()), normalizeIdentity(item["cuisine"]?.toString()), ingredients)
    }
    val dishes = (food["dishes"] as? List<*>)?.mapNotNull { it as? Map<*, *> }?.map(::identity).orEmpty()
        .sortedWith(compareBy { CraveJson.encodeToString(it) })
    return CravingIdentity(identity(food), dishes)
}
