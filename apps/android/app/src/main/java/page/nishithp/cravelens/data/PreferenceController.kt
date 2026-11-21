package page.nishithp.cravelens.data

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import page.nishithp.cravelens.core.json.CraveJson
import page.nishithp.cravelens.core.model.PreferenceJob
import page.nishithp.cravelens.core.model.PreferenceRequest
import page.nishithp.cravelens.core.preferences.PreferenceTriggerReason
import page.nishithp.cravelens.core.preferences.SavedInferredProfile
import page.nishithp.cravelens.core.preferences.decidePreferenceBuild
import page.nishithp.cravelens.core.preferences.parsePreferenceJob
import page.nishithp.cravelens.core.preferences.parseSavedAddresses

data class PreferenceUiState(
    val status: String = "Not built yet. It runs after Swiggy is connected and a delivery address is loaded.",
    val steps: List<String> = emptyList(),
    val busy: Boolean = false,
    val draft: String? = null,
    val notes: String = "",
    val coverage: String = "",
    val awaitingHostedModel: Boolean = false,
    val runId: String = "",
)

class PreferenceController(
    private val api: CraveApi,
    private val context: Context,
    private val scope: CoroutineScope,
) {
    var ui by mutableStateOf(PreferenceUiState())
        private set
    private var poll: Job? = null
    private var automaticChecked = false

    fun considerAutomatic() {
        if (automaticChecked || ui.busy) return
        automaticChecked = true
        scope.launch {
            val saved = snapshot().preferenceJobId
            if (saved.matches(RunId)) resume(saved) else evaluate(manual = false)
        }
    }

    fun rebuild() {
        scope.launch { evaluate(manual = true) }
    }

    fun acceptDraft() {
        val draft = ui.draft ?: return
        scope.launch {
            AppPrefs.update(context) { it.copy(personalContext = draft.take(1000)) }
            ui = ui.copy(draft = null, status = "Your refined preferences have been saved.")
        }
    }

    fun keepOriginal() {
        ui = ui.copy(draft = null, status = "Original preferences kept.")
    }

    fun hostedDecision(approve: Boolean) {
        val runId = ui.runId
        if (!runId.matches(RunId)) return
        scope.launch {
            val body = """{"decision":"${if (approve) "approve" else "deny"}"}"""
            val result = withContext(Dispatchers.IO) { api.post("/api/orchestrate/$runId/fallback", body) }
            if (!result.ok) ui = ui.copy(status = serverError(result))
            else ui = ui.copy(awaitingHostedModel = false, status = if (approve) "Continuing with the hosted model…" else "Stopped without switching models.")
        }
    }

    private suspend fun evaluate(manual: Boolean) {
        val session = withContext(Dispatchers.IO) { api.createSession() }
        if (api.accessToken == null) {
            ui = ui.copy(busy = false, status = session)
            return
        }
        val statusBody = withContext(Dispatchers.IO) { api.get("/api/swiggy/auth/status") }
        val swiggy = statusOf(statusBody)
        if (swiggy == null) {
            if (manual) ui = ui.copy(busy = false, status = statusBody)
            return
        }
        val connected = swiggy == "connected"
        val prefs = snapshot()
        if (!connected) {
            if (statusOf(statusBody) == "missing" || statusOf(statusBody) == "failed") {
                AppPrefs.update(context) { it.copy(swiggyConnectionSeen = false) }
            }
            val decision = decidePreferenceBuild(prefs.personalContext, prefs.addressId, false, prefs.inferred(), System.currentTimeMillis(), true, false)
            ui = ui.copy(busy = false, status = if (manual) decision.message ?: statusBody else "Swiggy is not connected on this device. Reconnect, then rebuild personal context.")
            return
        }
        val addressBody = withContext(Dispatchers.IO) { api.get("/api/swiggy/addresses") }
        val addresses = parseSavedAddresses(addressBody)
        if (addresses.isEmpty() && !addressBody.trimStart().startsWith("{")) {
            if (manual) ui = ui.copy(busy = false, status = addressBody)
            return
        }
        val chosen = addresses.firstOrNull { it.id == prefs.addressId } ?: addresses.firstOrNull()
        val addressId = chosen?.id.orEmpty()
        val label = chosen?.let { listOf(it.receiverName, it.addressString).filter { part -> part.isNotBlank() }.joinToString(" · ") }.orEmpty()
        val connectionChanged = !prefs.swiggyConnectionSeen
        AppPrefs.update(context) { it.copy(addressId = addressId, addressLabel = label.ifBlank { it.addressLabel }, swiggyConnectionSeen = true) }
        val current = snapshot()
        val decision = decidePreferenceBuild(current.personalContext, addressId, true, current.inferred(), System.currentTimeMillis(), manual, connectionChanged)
        val reason = decision.reason
        if (reason == null) {
            ui = ui.copy(
                busy = false,
                status = when {
                    manual -> decision.message ?: ui.status
                    current.inferredGeneratedAt > 0L -> "Saved inferred preferences are still in date. Typed preferences still take priority."
                    else -> ui.status
                },
            )
            return
        }
        start(reason, current.personalContext, addressId)
    }

    private suspend fun start(reason: PreferenceTriggerReason, personalContext: String, addressId: String) {
        poll?.cancel()
        ui = PreferenceUiState(status = "Starting preferences agent…", busy = true)
        val body = CraveJson.encodeToString(PreferenceRequest.serializer(), PreferenceRequest(personalContext.trim().take(1000), addressId))
        val posted = withContext(Dispatchers.IO) { api.post("/api/preferences/build", body) }
        val job = parsePreferenceJob(posted.body)
        if (!posted.ok || job == null) {
            ui = PreferenceUiState(status = serverError(posted), busy = false)
            return
        }
        show(job)
        if (job.status == "running") {
            AppPrefs.update(context) { it.copy(preferenceJobId = job.runId) }
            poll(job.runId, reason)
        } else finish(job, reason)
    }

    private suspend fun resume(runId: String) {
        val session = withContext(Dispatchers.IO) { api.createSession() }
        if (api.accessToken == null) {
            ui = ui.copy(status = session)
            return
        }
        val body = withContext(Dispatchers.IO) { api.get("/api/preferences/build/$runId") }
        val job = parsePreferenceJob(body)
        if (job == null) {
            AppPrefs.update(context) { it.copy(preferenceJobId = "") }
            evaluate(manual = false)
            return
        }
        show(job)
        if (job.status == "running") poll(job.runId, PreferenceTriggerReason.MANUAL) else finish(job, PreferenceTriggerReason.MANUAL)
    }

    private fun poll(runId: String, reason: PreferenceTriggerReason) {
        if (!runId.matches(RunId)) {
            ui = PreferenceUiState(status = "Preferences run id was not valid.", busy = false)
            return
        }
        poll = scope.launch {
            var current = runId
            repeat(600) {
                delay(500)
                val result = withContext(Dispatchers.IO) { api.get("/api/preferences/build/$current") }
                val job = parsePreferenceJob(result) ?: run {
                    ui = PreferenceUiState(status = result, busy = false)
                    return@launch
                }
                show(job)
                if (job.status != "running") {
                    finish(job, reason)
                    return@launch
                }
            }
            ui = ui.copy(busy = false, status = "Preference building timed out. Try again.")
        }
    }

    private fun show(job: PreferenceJob) {
        ui = PreferenceUiState(
            status = job.error ?: job.progress.lastOrNull()?.message ?: "Starting preferences agent…",
            steps = job.progress.map { it.message },
            busy = job.status == "running",
            notes = job.result?.notes.orEmpty(),
            coverage = coverage(job),
            awaitingHostedModel = job.status == "running" && job.fallback?.status == "pending" && job.fallback?.delivery != "telegram",
            runId = job.runId,
        )
    }

    private suspend fun finish(job: PreferenceJob, reason: PreferenceTriggerReason) {
        when (job.status) {
            "ready" -> if (reason == PreferenceTriggerReason.MANUAL) {
                ui = ui.copy(busy = false, draft = job.result?.preferences, status = job.progress.lastOrNull()?.message ?: "Suggestion ready. Review it before accepting.")
            } else {
                store(job)
                ui = ui.copy(busy = false, status = "Inferred preferences saved. Your typed preferences still take priority.")
            }
            "no_history" -> {
                store(job)
                ui = ui.copy(busy = false, status = "No verified history was available. No suggestion was generated; your preferences are unchanged.")
            }
            else -> ui = ui.copy(busy = false, status = job.error ?: "Could not build preferences.")
        }
    }

    private suspend fun store(job: PreferenceJob) {
        val result = job.result
        AppPrefs.update(context) {
            it.copy(
                inferredPreferences = result?.preferences.orEmpty(),
                inferredNotes = result?.notes.orEmpty(),
                inferredGeneratedAt = System.currentTimeMillis(),
                inferredAddressId = it.addressId,
                inferredMatched = result?.history?.matched ?: 0,
                inferredChecked = result?.history?.checked ?: 0,
                inferredIncomplete = result?.history?.incomplete == true,
                preferenceJobId = "",
            )
        }
    }

    private suspend fun snapshot(): CravePrefs = AppPrefs.flow(context).first()
}

private val RunId = Regex("^[a-fA-F0-9-]{36}$")

private fun CravePrefs.inferred() = if (inferredGeneratedAt == 0L) null else SavedInferredProfile(
    addressId = inferredAddressId,
    preferences = inferredPreferences,
    generatedAt = inferredGeneratedAt,
    checked = inferredChecked,
    incomplete = inferredIncomplete,
)

private fun statusOf(body: String) = Regex(""""status"\s*:\s*"([^"]+)"""").find(body)?.groupValues?.get(1)

private fun coverage(job: PreferenceJob): String {
    val history = job.result?.history ?: return ""
    val noun = if (history.matched == 1) "order" else "orders"
    val scope = if (history.incomplete) "Limited history" else "Account history"
    return "${history.matched} $noun · $scope"
}
