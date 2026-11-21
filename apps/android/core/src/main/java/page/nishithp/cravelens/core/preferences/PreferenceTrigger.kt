package page.nishithp.cravelens.core.preferences

import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import page.nishithp.cravelens.core.json.CraveJson
import page.nishithp.cravelens.core.model.PreferenceJob
import page.nishithp.cravelens.core.model.SavedAddress

/**
 * Same freshness window as the server preference bootstrap: a profile with
 * text lasts 30 days, and an empty history result is checked again after a day.
 */
const val PREFERENCE_PROFILE_LIFETIME_MS = 30L * 24 * 60 * 60 * 1000
const val EMPTY_HISTORY_LIFETIME_MS = 24L * 60 * 60 * 1000

data class SavedInferredProfile(
    val addressId: String,
    val preferences: String,
    val generatedAt: Long,
    val checked: Int = 0,
    val incomplete: Boolean = false,
    val notes: String = "",
    val matched: Int = 0,
)

enum class PreferenceTriggerReason {
    MANUAL,
    FIRST_AFTER_SIGN_IN,
    ADDRESS_CHANGED,
    STALE,
}

data class PreferenceTriggerDecision(
    val reason: PreferenceTriggerReason? = null,
    val message: String? = null,
)

/**
 * Decides whether to call `POST /api/preferences/build`.
 *
 * Automatic runs match the server bootstrap: explicit text always wins, and a
 * profile is rebuilt on the first connected session, when the Swiggy connection
 * changes, when the delivery address changes, or when it is older than the
 * bootstrap lifetime. A manual rebuild is the extension sparkle: it needs a
 * connected account and a delivery address, and it sends the current text.
 */
fun decidePreferenceBuild(
    explicitContext: String,
    addressId: String?,
    swiggyConnected: Boolean,
    saved: SavedInferredProfile?,
    nowMs: Long,
    manual: Boolean,
    connectionChanged: Boolean,
): PreferenceTriggerDecision {
    val address = addressId?.trim().orEmpty()
    if (manual) {
        if (!swiggyConnected) {
            return PreferenceTriggerDecision(message = "Reconnect your Swiggy account, select a delivery address, then build preferences again.")
        }
        if (address.isEmpty()) {
            return PreferenceTriggerDecision(message = "Select a delivery address before building preferences.")
        }
        return PreferenceTriggerDecision(reason = PreferenceTriggerReason.MANUAL)
    }
    if (explicitContext.trim().isNotEmpty() || !swiggyConnected || address.isEmpty()) return PreferenceTriggerDecision()
    val usable = saved?.takeUnless { it.preferences.isEmpty() && it.checked > 0 && it.incomplete }
    if (usable == null || connectionChanged) return PreferenceTriggerDecision(reason = PreferenceTriggerReason.FIRST_AFTER_SIGN_IN)
    if (usable.addressId != address) return PreferenceTriggerDecision(reason = PreferenceTriggerReason.ADDRESS_CHANGED)
    val lifetime = if (usable.preferences.isNotBlank()) PREFERENCE_PROFILE_LIFETIME_MS else EMPTY_HISTORY_LIFETIME_MS
    if (nowMs - usable.generatedAt >= lifetime) return PreferenceTriggerDecision(reason = PreferenceTriggerReason.STALE)
    return PreferenceTriggerDecision()
}

/** The extension treats a ready job with no matched orders as no history. */
fun normalizePreferenceJob(job: PreferenceJob): PreferenceJob {
    if (job.status == "ready" && (job.result?.history?.matched ?: 0) == 0) return job.copy(status = "no_history")
    return job
}

fun parsePreferenceJob(body: String): PreferenceJob? = runCatching {
    normalizePreferenceJob(CraveJson.decodeFromString(PreferenceJob.serializer(), body))
}.getOrNull()?.takeIf { it.runId.isNotBlank() }

/** A cart response can carry the profile the server built during cart preparation. */
fun parseAttachedProfile(body: String): SavedInferredProfile? = runCatching {
    val profile = CraveJson.parseToJsonElement(body).jsonObject["suggestion"]?.jsonObject?.get("preferenceProfile")?.jsonObject ?: return null
    val history = profile["history"]?.jsonObject
    SavedInferredProfile(
        addressId = profile["addressId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        preferences = profile["preferences"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        generatedAt = profile["generatedAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0,
        checked = history?.get("checked")?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
        incomplete = history?.get("incomplete")?.jsonPrimitive?.contentOrNull == "true",
        notes = profile["notes"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        matched = history?.get("matched")?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
    ).takeIf { it.addressId.isNotBlank() && it.generatedAt > 0 }
}.getOrNull()

fun parseSavedAddresses(body: String): List<SavedAddress> = runCatching {
    val parsed = CraveJson.decodeFromString(AddressList.serializer(), body)
    parsed.addresses.filter { it.id.isNotBlank() }
}.getOrDefault(emptyList())

@kotlinx.serialization.Serializable
private data class AddressList(val addresses: List<SavedAddress> = emptyList())
