package page.nishithp.cravelens.core.json

import kotlinx.serialization.json.Json

val CraveJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    classDiscriminator = "action"
}
