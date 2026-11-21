package page.nishithp.cravelens.data

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import page.nishithp.cravelens.core.auth.SWIGGY_POLL_INTERVAL_MS
import page.nishithp.cravelens.core.auth.SwiggyAuthStatus
import page.nishithp.cravelens.core.auth.SwiggyPollKind
import page.nishithp.cravelens.core.auth.advanceSwiggyPoll
import page.nishithp.cravelens.core.auth.parseSwiggyAuthStart
import page.nishithp.cravelens.core.auth.parseSwiggyAuthStatus
import page.nishithp.cravelens.core.auth.swiggyPollDeadline
import java.text.DateFormat
import java.util.Date

data class SwiggyAuthUiState(
    val phase: String = "disconnected",
    val title: String = "Swiggy isn’t connected",
    val detail: String = "Connect your Swiggy account to continue",
) {
    val showConnect: Boolean get() = phase == "disconnected" || phase == "failed"
    val showDisconnect: Boolean get() = phase == "connected"
}

class SwiggyAuthController(
    private val api: CraveApi,
    private val context: Context,
    private val scope: CoroutineScope,
    private val openAuthorization: (String) -> Boolean,
    private val onConnected: () -> Unit,
) {
    var ui by mutableStateOf(SwiggyAuthUiState())
        private set
    private var poll: Job? = null
    private var announcedConnection = false

    fun refresh() {
        scope.launch { refreshOnce() }
    }

    fun connect() {
        scope.launch { begin() }
    }

    fun disconnect() {
        scope.launch { disconnectAccount() }
    }

    private suspend fun begin() {
        if (!ensureSession()) return
        val current = fetchStatus() ?: return
        if (current.status == "connected") {
            apply(current, System.currentTimeMillis(), startedHere = false)
            return
        }
        poll?.cancel()
        ui = SwiggyAuthUiState("connecting", "Connecting to Swiggy…", "Complete sign-in in the secure Swiggy window")
        val posted = withContext(Dispatchers.IO) { api.post("/api/swiggy/auth/start", "{}") }
        val start = parseSwiggyAuthStart(posted.body)
        if (!posted.ok || start == null) {
            announcedConnection = false
            val detail = if (!posted.ok) serverError(posted) else "Swiggy did not return a sign-in page."
            ui = SwiggyAuthUiState("failed", "Swiggy isn’t connected", detail)
            return
        }
        clearInferredProfile()
        val opened = openAuthorization(start.authorizationUrl)
        if (!opened) {
            ui = SwiggyAuthUiState("failed", "Swiggy isn’t connected", "No browser is available to sign in to Swiggy.")
            return
        }
        pollUntil(swiggyPollDeadline(System.currentTimeMillis()), startedHere = true)
    }

    private suspend fun refreshOnce() {
        if (!ensureSession()) return
        val current = fetchStatus() ?: return
        val now = System.currentTimeMillis()
        apply(current, now, startedHere = false)
        if (current.status == "pending" && (current.expiresAt == 0L || now < current.expiresAt) && poll?.isActive != true) {
            pollUntil(swiggyPollDeadline(now), startedHere = false)
        }
    }

    private fun pollUntil(deadline: Long, startedHere: Boolean) {
        poll?.cancel()
        poll = scope.launch {
            while (isActive) {
                val gate = advanceSwiggyPoll(System.currentTimeMillis(), deadline, null)
                if (gate.kind == SwiggyPollKind.TIMED_OUT) {
                    announcedConnection = false
                    ui = SwiggyAuthUiState("failed", "Swiggy isn’t connected", gate.message)
                    return@launch
                }
                delay(SWIGGY_POLL_INTERVAL_MS)
                val status = fetchStatus() ?: return@launch
                apply(status, System.currentTimeMillis(), startedHere)
                if (ui.phase != "pending" && ui.phase != "connecting") return@launch
            }
        }
    }

    private fun apply(status: SwiggyAuthStatus, now: Long, startedHere: Boolean) {
        val step = advanceSwiggyPoll(now, Long.MAX_VALUE, status)
        when (step.kind) {
            SwiggyPollKind.CONNECTED -> {
                poll?.cancel()
                ui = SwiggyAuthUiState("connected", "Swiggy connected", sessionDetail(step.expiresAt))
                if (!announcedConnection) {
                    announcedConnection = true
                    onConnected()
                }
            }
            SwiggyPollKind.FAILED -> {
                poll?.cancel()
                announcedConnection = false
                ui = SwiggyAuthUiState("failed", "Swiggy isn’t connected", step.message)
            }
            else -> if (ui.phase != "connecting" || !startedHere) {
                ui = SwiggyAuthUiState("pending", "Waiting for Swiggy sign-in…", "Finish signing in, then return here")
            }
        }
    }

    private suspend fun disconnectAccount() {
        if (!ensureSession()) return
        poll?.cancel()
        val result = withContext(Dispatchers.IO) { api.delete("/api/swiggy/auth") }
        if (!result.ok) {
            ui = ui.copy(detail = serverError(result))
            return
        }
        clearInferredProfile()
        announcedConnection = false
        ui = SwiggyAuthUiState()
    }

    private suspend fun ensureSession(): Boolean {
        val failure = withContext(Dispatchers.IO) { api.ensureSession() }
        if (failure == null) return true
        ui = SwiggyAuthUiState("failed", "Swiggy isn’t connected", failure)
        return false
    }

    private suspend fun fetchStatus(): SwiggyAuthStatus? {
        val body = withContext(Dispatchers.IO) { api.get("/api/swiggy/auth/status") }
        return parseSwiggyAuthStatus(body) ?: run {
            ui = SwiggyAuthUiState("failed", "Swiggy isn’t connected", body)
            null
        }
    }

    private suspend fun clearInferredProfile() {
        AppPrefs.update(context) {
            it.copy(
                inferredPreferences = "",
                inferredNotes = "",
                inferredGeneratedAt = 0,
                inferredAddressId = "",
                inferredMatched = 0,
                inferredChecked = 0,
                inferredIncomplete = false,
                preferenceJobId = "",
                swiggyConnectionSeen = false,
            )
        }
    }
}

private fun sessionDetail(expiresAt: Long): String {
    if (expiresAt <= 0L) return "Swiggy connected"
    val date = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(expiresAt))
    return "Session active until $date"
}
