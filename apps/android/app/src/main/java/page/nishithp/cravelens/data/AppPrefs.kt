package page.nishithp.cravelens.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.craveStore by preferencesDataStore("cravelens-prefs")

data class CravePrefs(
    val onboarded: Boolean = false,
    val dynamicColor: Boolean = false,
    val themeMode: String = "system",
    val sensitivity: Float = 0.38f,
    val scanIntervalMs: Int = 1000,
    val debugOverlay: Boolean = false,
    val hostedFallback: String = "ask",
    val thinking: Boolean = false,
    val contextTokens: Int = 16384,
    val cartExperience: String = "screen",
    val telegramSilent: Boolean = false,
    val personalContext: String = "",
    val addressId: String = "",
    val addressLabel: String = "",
    val inferredPreferences: String = "",
    val inferredNotes: String = "",
    val inferredGeneratedAt: Long = 0,
    val inferredAddressId: String = "",
    val inferredMatched: Int = 0,
    val inferredChecked: Int = 0,
    val inferredIncomplete: Boolean = false,
    val swiggyConnectionSeen: Boolean = false,
    val preferenceJobId: String = "",
    val watchLabel: String = "Off",
    val cartSummary: String = "No cart is waiting. Check the server when a watching session prepares one.",
)

object AppPrefs {
    private val onboarded = booleanPreferencesKey("onboarded")
    private val dynamicColor = booleanPreferencesKey("dynamicColor")
    private val themeMode = stringPreferencesKey("themeMode")
    private val sensitivity = floatPreferencesKey("sensitivity")
    private val scanIntervalMs = intPreferencesKey("scanIntervalMs")
    private val debugOverlay = booleanPreferencesKey("debugOverlay")
    private val hostedFallback = stringPreferencesKey("hostedFallback")
    private val thinking = booleanPreferencesKey("thinking")
    private val contextTokens = intPreferencesKey("contextTokens")
    private val cartExperience = stringPreferencesKey("cartExperience")
    private val telegramSilent = booleanPreferencesKey("telegramSilent")
    private val personalContext = stringPreferencesKey("personalContext")
    private val addressId = stringPreferencesKey("addressId")
    private val addressLabel = stringPreferencesKey("addressLabel")
    private val inferredPreferences = stringPreferencesKey("inferredPreferences")
    private val inferredNotes = stringPreferencesKey("inferredNotes")
    private val inferredGeneratedAt = longPreferencesKey("inferredGeneratedAt")
    private val inferredAddressId = stringPreferencesKey("inferredAddressId")
    private val inferredMatched = intPreferencesKey("inferredMatched")
    private val inferredChecked = intPreferencesKey("inferredChecked")
    private val inferredIncomplete = booleanPreferencesKey("inferredIncomplete")
    private val swiggyConnectionSeen = booleanPreferencesKey("swiggyConnectionSeen")
    private val preferenceJobId = stringPreferencesKey("preferenceJobId")
    private val watchLabel = stringPreferencesKey("watchLabel")
    private val cartSummary = stringPreferencesKey("cartSummary")

    fun flow(context: Context): Flow<CravePrefs> = context.craveStore.data.map { p ->
        CravePrefs(
            onboarded = p[onboarded] == true,
            dynamicColor = p[dynamicColor] == true,
            themeMode = p[themeMode] ?: "system",
            sensitivity = p[sensitivity] ?: 0.38f,
            scanIntervalMs = p[scanIntervalMs] ?: 1000,
            debugOverlay = p[debugOverlay] == true,
            hostedFallback = p[hostedFallback] ?: "ask",
            thinking = p[thinking] == true,
            contextTokens = p[contextTokens] ?: 16384,
            cartExperience = p[cartExperience] ?: "screen",
            telegramSilent = p[telegramSilent] == true,
            personalContext = p[personalContext].orEmpty(),
            addressId = p[addressId].orEmpty(),
            addressLabel = p[addressLabel].orEmpty(),
            inferredPreferences = p[inferredPreferences].orEmpty(),
            inferredNotes = p[inferredNotes].orEmpty(),
            inferredGeneratedAt = p[inferredGeneratedAt] ?: 0,
            inferredAddressId = p[inferredAddressId].orEmpty(),
            inferredMatched = p[inferredMatched] ?: 0,
            inferredChecked = p[inferredChecked] ?: 0,
            inferredIncomplete = p[inferredIncomplete] == true,
            swiggyConnectionSeen = p[swiggyConnectionSeen] == true,
            preferenceJobId = p[preferenceJobId].orEmpty(),
            watchLabel = p[watchLabel] ?: "Off",
            cartSummary = p[cartSummary] ?: CravePrefs().cartSummary,
        )
    }

    suspend fun update(context: Context, transform: (CravePrefs) -> CravePrefs) {
        context.craveStore.edit { prefs ->
            val current = CravePrefs(
                onboarded = prefs[onboarded] == true,
                dynamicColor = prefs[dynamicColor] == true,
                themeMode = prefs[themeMode] ?: "system",
                sensitivity = prefs[sensitivity] ?: 0.38f,
                scanIntervalMs = prefs[scanIntervalMs] ?: 1000,
                debugOverlay = prefs[debugOverlay] == true,
                hostedFallback = prefs[hostedFallback] ?: "ask",
                thinking = prefs[thinking] == true,
                contextTokens = prefs[contextTokens] ?: 16384,
                cartExperience = prefs[cartExperience] ?: "screen",
                telegramSilent = prefs[telegramSilent] == true,
                personalContext = prefs[personalContext].orEmpty(),
                addressId = prefs[addressId].orEmpty(),
                addressLabel = prefs[addressLabel].orEmpty(),
                inferredPreferences = prefs[inferredPreferences].orEmpty(),
                inferredNotes = prefs[inferredNotes].orEmpty(),
                inferredGeneratedAt = prefs[inferredGeneratedAt] ?: 0,
                inferredAddressId = prefs[inferredAddressId].orEmpty(),
                inferredMatched = prefs[inferredMatched] ?: 0,
                inferredChecked = prefs[inferredChecked] ?: 0,
                inferredIncomplete = prefs[inferredIncomplete] == true,
                swiggyConnectionSeen = prefs[swiggyConnectionSeen] == true,
                preferenceJobId = prefs[preferenceJobId].orEmpty(),
                watchLabel = prefs[watchLabel] ?: "Off",
                cartSummary = prefs[cartSummary] ?: CravePrefs().cartSummary,
            )
            val next = transform(current)
            prefs[onboarded] = next.onboarded
            prefs[dynamicColor] = next.dynamicColor
            prefs[themeMode] = next.themeMode
            prefs[sensitivity] = next.sensitivity
            prefs[scanIntervalMs] = next.scanIntervalMs
            prefs[debugOverlay] = next.debugOverlay
            prefs[hostedFallback] = next.hostedFallback
            prefs[thinking] = next.thinking
            prefs[contextTokens] = next.contextTokens
            prefs[cartExperience] = next.cartExperience
            prefs[telegramSilent] = next.telegramSilent
            prefs[personalContext] = next.personalContext
            prefs[addressId] = next.addressId
            prefs[addressLabel] = next.addressLabel
            prefs[inferredPreferences] = next.inferredPreferences
            prefs[inferredNotes] = next.inferredNotes
            prefs[inferredGeneratedAt] = next.inferredGeneratedAt
            prefs[inferredAddressId] = next.inferredAddressId
            prefs[inferredMatched] = next.inferredMatched
            prefs[inferredChecked] = next.inferredChecked
            prefs[inferredIncomplete] = next.inferredIncomplete
            prefs[swiggyConnectionSeen] = next.swiggyConnectionSeen
            prefs[preferenceJobId] = next.preferenceJobId
            prefs[watchLabel] = next.watchLabel
            prefs[cartSummary] = next.cartSummary
        }
    }
}
