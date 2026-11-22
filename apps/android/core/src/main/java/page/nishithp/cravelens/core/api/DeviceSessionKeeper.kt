package page.nishithp.cravelens.core.api

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import page.nishithp.cravelens.core.json.CraveJson
import page.nishithp.cravelens.core.model.DeviceSession
import java.util.concurrent.atomic.AtomicInteger

const val ACCESS_REFRESH_WINDOW_MS = 60_000L

interface DeviceSessionStore {
    fun load(): DeviceSession?
    fun save(session: DeviceSession)
}

sealed class RefreshOutcome {
    data class Rotated(val session: DeviceSession) : RefreshOutcome()
    data object Rejected : RefreshOutcome()
}

class SessionRefreshRejected : Exception("Device refresh was rejected")

data class HttpResult(val code: Int, val body: String) {
    val ok: Boolean get() = code in 200..299
}

fun parseDeviceSession(body: String): DeviceSession? = try {
    val session = CraveJson.decodeFromString(DeviceSession.serializer(), body)
    if (session.deviceId.isBlank() || session.accessToken.isBlank() || session.refreshToken.isBlank()) null else session
} catch (_: Exception) {
    null
}

class DeviceSessionKeeper(
    private val store: DeviceSessionStore,
    private val createCall: suspend () -> DeviceSession,
    private val refreshCall: suspend (String) -> RefreshOutcome,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val loaded = lazy { store.load().also { memory = it } }
    @Volatile private var memory: DeviceSession? = null
    private val generation = AtomicInteger(0)
    private val createMutex = Mutex()
    private val refresher = TokenRefresher(
        current = { current() },
        store = { next ->
            memory = next
            store.save(next)
        },
        refreshCall = { token ->
            when (val outcome = refreshCall(token)) {
                is RefreshOutcome.Rotated -> outcome.session
                RefreshOutcome.Rejected -> throw SessionRefreshRejected()
            }
        },
    )

    val deviceId: String? get() = current()?.deviceId

    suspend fun bearer(): String {
        if (current() == null) return createReplacing(generation.get()).accessToken
        return try {
            refresher.validSession(now()).accessToken
        } catch (_: SessionRefreshRejected) {
            createReplacing(generation.get()).accessToken
        }
    }

    suspend fun afterUnauthorized(): String = try {
        refresher.refreshAfterUnauthorized().accessToken
    } catch (_: SessionRefreshRejected) {
        createReplacing(generation.get()).accessToken
    }

    private fun current(): DeviceSession? {
        loaded.value
        return memory
    }

    private suspend fun createReplacing(seen: Int): DeviceSession = createMutex.withLock {
        if (generation.get() != seen) return current() ?: throw IllegalStateException("Device session is missing")
        val next = createCall()
        memory = next
        generation.incrementAndGet()
        store.save(next)
        next
    }
}

class AuthorizedCaller(
    private val sessions: DeviceSessionKeeper,
    private val send: suspend (token: String, method: String, path: String, body: String?) -> HttpResult,
) {
    suspend fun call(method: String, path: String, body: String? = null): HttpResult {
        val token = sessions.bearer()
        val first = send(token, method, path, body)
        if (first.code != 401) return first
        val next = sessions.afterUnauthorized()
        if (next == token) return first
        return send(next, method, path, body)
    }
}
