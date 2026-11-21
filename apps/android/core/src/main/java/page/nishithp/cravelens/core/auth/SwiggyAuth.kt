package page.nishithp.cravelens.core.auth

import kotlinx.serialization.Serializable
import page.nishithp.cravelens.core.json.CraveJson
import java.net.URI

/** Same wait as `apps/extension/src/oauth.js`: 1.2 seconds, for five minutes. */
const val SWIGGY_POLL_INTERVAL_MS = 1_200L
const val SWIGGY_POLL_WINDOW_MS = 5 * 60_000L

const val SWIGGY_SIGN_IN_EXPIRED = "Swiggy sign-in session expired."
const val SWIGGY_SIGN_IN_TIMED_OUT = "Swiggy sign-in timed out. Try connecting again."

@Serializable
data class SwiggyAuthStatus(
    val status: String = "",
    val expiresAt: Long = 0,
    val error: String? = null,
)

@Serializable
data class SwiggyAuthStart(
    val authorizationUrl: String = "",
    val expiresAt: Long = 0,
)

enum class SwiggyPollKind { CONTINUE, CONNECTED, FAILED, TIMED_OUT }

data class SwiggyPollStep(
    val kind: SwiggyPollKind,
    val message: String,
    val expiresAt: Long = 0,
)

fun swiggyPollDeadline(nowMs: Long) = nowMs + SWIGGY_POLL_WINDOW_MS

/**
 * One step of `waitForConnection`. A null status is the check before the 1.2 second
 * sleep: the loop stops at the deadline and does not fetch again. A fetched status
 * is interpreted even if the sleep crossed the deadline, and a pending `expiresAt`
 * that has passed is a failure.
 */
fun advanceSwiggyPoll(nowMs: Long, deadlineMs: Long, status: SwiggyAuthStatus?): SwiggyPollStep {
    if (status == null) {
        return if (nowMs >= deadlineMs) SwiggyPollStep(SwiggyPollKind.TIMED_OUT, SWIGGY_SIGN_IN_TIMED_OUT)
        else SwiggyPollStep(SwiggyPollKind.CONTINUE, "Waiting for Swiggy sign-in…")
    }
    return when (status.status) {
        "connected" -> SwiggyPollStep(SwiggyPollKind.CONNECTED, "Swiggy connected", status.expiresAt)
        "failed", "missing" -> SwiggyPollStep(
            SwiggyPollKind.FAILED,
            status.error?.takeIf { it.isNotBlank() } ?: SWIGGY_SIGN_IN_EXPIRED,
        )
        "pending" -> if (status.expiresAt > 0 && nowMs >= status.expiresAt) {
            SwiggyPollStep(SwiggyPollKind.FAILED, status.error?.takeIf { it.isNotBlank() } ?: SWIGGY_SIGN_IN_EXPIRED)
        } else {
            SwiggyPollStep(SwiggyPollKind.CONTINUE, "Waiting for Swiggy sign-in…", status.expiresAt)
        }
        else -> SwiggyPollStep(SwiggyPollKind.CONTINUE, "Waiting for Swiggy sign-in…")
    }
}

fun parseSwiggyAuthStatus(body: String): SwiggyAuthStatus? = runCatching {
    CraveJson.decodeFromString(SwiggyAuthStatus.serializer(), body)
}.getOrNull()?.takeIf { it.status.isNotBlank() }

fun parseSwiggyAuthStart(body: String): SwiggyAuthStart? = runCatching {
    CraveJson.decodeFromString(SwiggyAuthStart.serializer(), body)
}.getOrNull()?.takeIf { isSwiggyAuthorizationUrl(it.authorizationUrl) }

/** The Custom Tab may open an https URL, or http only for localhost. */
fun isSwiggyAuthorizationUrl(url: String): Boolean {
    val parsed = runCatching { URI(url) }.getOrNull() ?: return false
    val scheme = parsed.scheme?.lowercase() ?: return false
    val host = parsed.host?.lowercase().orEmpty()
    if (host.isBlank()) return false
    return scheme == "https" || (scheme == "http" && (host == "localhost" || host == "127.0.0.1"))
}
