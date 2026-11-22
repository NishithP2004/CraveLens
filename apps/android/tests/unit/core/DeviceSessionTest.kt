package page.nishithp.cravelens.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import page.nishithp.cravelens.core.api.AuthorizedCaller
import page.nishithp.cravelens.core.api.DeviceSessionKeeper
import page.nishithp.cravelens.core.api.DeviceSessionStore
import page.nishithp.cravelens.core.api.HttpResult
import page.nishithp.cravelens.core.api.RefreshOutcome
import page.nishithp.cravelens.core.api.ordersHistoryPath
import page.nishithp.cravelens.core.api.parseDeviceSession
import page.nishithp.cravelens.core.json.CraveJson
import page.nishithp.cravelens.core.model.DeviceSession
import java.util.concurrent.atomic.AtomicInteger

class DeviceSessionTest {
    @Test fun storedSessionRoundTripsEveryField() {
        val session = DeviceSession("device-1", "access-1", 1_700_000_000_000, "refresh-1", 1_800_000_000_000)
        val encoded = CraveJson.encodeToString(DeviceSession.serializer(), session)
        assertEquals(session, parseDeviceSession(encoded))
        assertEquals(null, parseDeviceSession("""{"error":"Refresh token is invalid"}"""))
    }

    @Test fun freshStoredSessionIsReused() = runBlocking {
        val store = MemoryStore()
        val server = ScriptedServer()
        val first = keeper(store, server)
        assertEquals("access-1", first.bearer())
        val second = keeper(store, server)
        assertEquals("access-1", second.bearer())
        assertEquals(1, server.creates.get())
        assertEquals(0, server.refreshes.get())
        assertEquals("device-1", second.deviceId)
        assertEquals("refresh-1", store.load()?.refreshToken)
    }

    @Test fun nearExpiryRotatesAndPersistsTheNewPair() = runBlocking {
        val now = System.currentTimeMillis()
        val store = MemoryStore(DeviceSession("device-1", "access-old", now + 5_000, "refresh-old", now + 86_400_000))
        val server = ScriptedServer()
        val session = keeper(store, server)
        assertEquals("access-2", session.bearer())
        assertEquals(0, server.creates.get())
        assertEquals(1, server.refreshes.get())
        val saved = store.load()
        assertEquals("device-1", saved?.deviceId)
        assertEquals("access-2", saved?.accessToken)
        assertEquals("refresh-2", saved?.refreshToken)
        assertTrue((saved?.accessExpiresAt ?: 0) > now + 60_000)
    }

    @Test fun rejectedRefreshCreatesOneReplacementSession() = runBlocking {
        val now = System.currentTimeMillis()
        val store = MemoryStore(DeviceSession("device-old", "access-old", now + 5_000, "refresh-dead", now + 86_400_000))
        val server = ScriptedServer(refreshRejected = true)
        val session = keeper(store, server)
        assertEquals("access-1", session.bearer())
        assertEquals(1, server.creates.get())
        assertEquals("device-1", store.load()?.deviceId)
        assertEquals("refresh-1", store.load()?.refreshToken)
    }

    @Test fun unauthorizedCallRefreshesOnceAndRetries() = runBlocking {
        val store = MemoryStore()
        val server = ScriptedServer(apiCodes = ArrayDeque(listOf(401, 200)))
        val caller = AuthorizedCaller(keeper(store, server), server::send)
        server.prepare("device-1")
        val result = caller.call("GET", "/api/swiggy/auth/status")
        assertEquals(200, result.code)
        assertTrue(result.body.contains("\"status\":\"connected\""))
        assertEquals(1, server.refreshes.get())
        assertEquals(2, server.sends.get())
        assertEquals("access-2", server.lastToken)
        assertEquals(1, server.creates.get())
    }

    @Test fun secondUnauthorizedResponseIsNotRetriedAgain() = runBlocking {
        val store = MemoryStore()
        val server = ScriptedServer(apiCodes = ArrayDeque(listOf(401, 401)))
        val caller = AuthorizedCaller(keeper(store, server), server::send)
        server.prepare("device-1")
        val result = caller.call("GET", "/api/cart/active")
        assertEquals(401, result.code)
        assertEquals(1, server.refreshes.get())
        assertEquals(2, server.sends.get())
    }

    @Test fun concurrentRefreshUsesOneToken() = runBlocking {
        val now = System.currentTimeMillis()
        val store = MemoryStore(DeviceSession("device-1", "access-old", now, "refresh-old", now + 86_400_000))
        val server = ScriptedServer(holdRefresh = true)
        val session = keeper(store, server)
        val jobs = (1..8).map { async(kotlinx.coroutines.Dispatchers.Default) { session.bearer() } }
        while (server.refreshes.get() == 0) delay(5)
        delay(30)
        server.releaseRefresh.complete(Unit)
        val tokens = jobs.awaitAll()
        assertEquals(1, server.refreshes.get())
        assertEquals(0, server.creates.get())
        assertTrue(tokens.all { it == "access-2" })
        assertEquals("refresh-2", store.load()?.refreshToken)
    }

    @Test fun recreatedClientObservesSwiggyConnectedOnTheSameDevice() = runBlocking {
        val store = MemoryStore()
        val server = ScriptedServer()
        val started = keeper(store, server)
        val deviceId = started.bearer()
        assertEquals("access-1", deviceId)
        val caller = AuthorizedCaller(started, server::send)
        server.prepare(started.deviceId ?: error("missing device"))
        server.status = "pending"
        assertTrue(caller.call("GET", "/api/swiggy/auth/status").body.contains("pending"))
        server.status = "connected"
        val recreated = AuthorizedCaller(keeper(store, server), server::send)
        val status = recreated.call("GET", "/api/swiggy/auth/status")
        assertEquals(200, status.code)
        assertTrue(status.body.contains("\"status\":\"connected\""))
        assertTrue(status.body.contains("device-1"))
        assertEquals(1, server.creates.get())
        assertEquals("device-1", store.load()?.deviceId)
        assertFalse(status.body.contains("missing"))
    }

    @Test fun orderHistoryRequiresTheSavedAddress() {
        assertEquals(null, ordersHistoryPath("  "))
        assertEquals("/api/orders?limit=20&addressId=addr-1", ordersHistoryPath("addr-1"))
        assertEquals("/api/orders?limit=20&addressId=addr+1%26west", ordersHistoryPath("addr 1&west", 99))
    }

    private fun keeper(store: MemoryStore, server: ScriptedServer) = DeviceSessionKeeper(
        store = store,
        createCall = { server.create() },
        refreshCall = { token -> server.refresh(token) },
    )
}

private class MemoryStore(initial: DeviceSession? = null) : DeviceSessionStore {
    private var session = initial
    override fun load(): DeviceSession? = session
    override fun save(session: DeviceSession) { this.session = session }
}

private class ScriptedServer(
    private val apiCodes: ArrayDeque<Int> = ArrayDeque(),
    private val refreshRejected: Boolean = false,
    private val holdRefresh: Boolean = false,
) {
    val creates = AtomicInteger()
    val refreshes = AtomicInteger()
    val sends = AtomicInteger()
    val releaseRefresh = CompletableDeferred<Unit>()
    var status = "connected"
    var lastToken: String? = null
    private val devices = linkedMapOf<String, String>()

    fun prepare(deviceId: String) {
        if (!devices.containsKey("access-1")) devices["access-1"] = deviceId
    }

    suspend fun create(): DeviceSession {
        val count = creates.incrementAndGet()
        val deviceId = "device-$count"
        val access = "access-$count"
        devices[access] = deviceId
        return DeviceSession(deviceId, access, System.currentTimeMillis() + 900_000, "refresh-$count", Long.MAX_VALUE)
    }

    suspend fun refresh(token: String): RefreshOutcome {
        refreshes.incrementAndGet()
        if (holdRefresh) releaseRefresh.await()
        if (refreshRejected || token.contains("dead")) return RefreshOutcome.Rejected
        val deviceId = devices.entries.firstOrNull { it.key != token && it.value.startsWith("device-") }?.value
            ?: devices[token.replace("refresh", "access")]
            ?: "device-1"
        val access = "access-${refreshes.get() + 1}"
        devices[access] = deviceId
        return RefreshOutcome.Rotated(DeviceSession(deviceId, access, System.currentTimeMillis() + 900_000, "refresh-${refreshes.get() + 1}", Long.MAX_VALUE))
    }

    fun send(token: String, method: String, path: String, body: String?): HttpResult {
        sends.incrementAndGet()
        lastToken = token
        val code = if (apiCodes.isEmpty()) 200 else apiCodes.removeFirst()
        val deviceId = devices[token] ?: "unknown"
        val payload = if (path.endsWith("/status")) """{"status":"$status","deviceId":"$deviceId"}""" else """{"ok":true,"method":"$method"}"""
        return HttpResult(code, if (code == 200) payload else """{"error":"unauthorized"}""")
    }
}
