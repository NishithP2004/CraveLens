package page.nishithp.cravelens.core.api

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import page.nishithp.cravelens.core.model.DeviceSession
import java.util.concurrent.TimeUnit

fun noRetryClient(): OkHttpClient = OkHttpClient.Builder()
    .retryOnConnectionFailure(false)
    .readTimeout(90, TimeUnit.SECONDS)
    .callTimeout(95, TimeUnit.SECONDS)
    .build()

class TokenRefresher(
    private val current: () -> DeviceSession?,
    private val store: (DeviceSession) -> Unit,
    private val refreshCall: suspend (String) -> DeviceSession,
) {
    private val mutex = Mutex()

    suspend fun validSession(now: Long = System.currentTimeMillis()): DeviceSession {
        val session = current() ?: throw IllegalStateException("Device session is missing")
        if (session.accessExpiresAt - now > 60_000) return session
        return refresh(session.refreshToken)
    }

    suspend fun refreshAfterUnauthorized(): DeviceSession {
        val refreshToken = current()?.refreshToken ?: throw IllegalStateException("Device session is missing")
        return refresh(refreshToken)
    }

    private suspend fun refresh(refreshToken: String): DeviceSession = mutex.withLock {
        val latest = current()
        if (latest != null && latest.refreshToken != refreshToken && latest.accessExpiresAt - System.currentTimeMillis() > 60_000) return latest
        val next = refreshCall(latest?.refreshToken ?: refreshToken)
        store(next)
        next
    }
}
