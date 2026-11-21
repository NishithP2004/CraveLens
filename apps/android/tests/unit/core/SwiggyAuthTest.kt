package page.nishithp.cravelens.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import page.nishithp.cravelens.core.auth.SWIGGY_POLL_INTERVAL_MS
import page.nishithp.cravelens.core.auth.SWIGGY_POLL_WINDOW_MS
import page.nishithp.cravelens.core.auth.SWIGGY_SIGN_IN_EXPIRED
import page.nishithp.cravelens.core.auth.SWIGGY_SIGN_IN_TIMED_OUT
import page.nishithp.cravelens.core.auth.SwiggyAuthStatus
import page.nishithp.cravelens.core.auth.SwiggyPollKind
import page.nishithp.cravelens.core.auth.advanceSwiggyPoll
import page.nishithp.cravelens.core.auth.isSwiggyAuthorizationUrl
import page.nishithp.cravelens.core.auth.parseSwiggyAuthStart
import page.nishithp.cravelens.core.auth.parseSwiggyAuthStatus
import page.nishithp.cravelens.core.auth.swiggyPollDeadline

class SwiggyAuthTest {
    private val start = 1_700_000_000_000L
    private val deadline = swiggyPollDeadline(start)

    @Test
    fun pollMatchesTheExtensionIntervalAndWindow() {
        assertEquals(1_200L, SWIGGY_POLL_INTERVAL_MS)
        assertEquals(5 * 60_000L, SWIGGY_POLL_WINDOW_MS)
        assertEquals(start + SWIGGY_POLL_WINDOW_MS, deadline)
    }

    @Test
    fun connectedAndFailedStopThePoll() {
        val connected = advanceSwiggyPoll(start, deadline, SwiggyAuthStatus("connected", expiresAt = start + 86_400_000))
        assertEquals(SwiggyPollKind.CONNECTED, connected.kind)
        assertEquals(start + 86_400_000, connected.expiresAt)
        val failed = advanceSwiggyPoll(start, deadline, SwiggyAuthStatus("failed", error = "access_denied"))
        assertEquals(SwiggyPollKind.FAILED, failed.kind)
        assertEquals("access_denied", failed.message)
        val missing = advanceSwiggyPoll(start, deadline, SwiggyAuthStatus("missing"))
        assertEquals(SWIGGY_SIGN_IN_EXPIRED, missing.message)
    }

    @Test
    fun pendingContinuesUntilExpiresAtOrTheDeadline() {
        val pending = advanceSwiggyPoll(start, deadline, SwiggyAuthStatus("pending", expiresAt = start + 60_000))
        assertEquals(SwiggyPollKind.CONTINUE, pending.kind)
        val expired = advanceSwiggyPoll(start + 60_000, deadline, SwiggyAuthStatus("pending", expiresAt = start + 60_000))
        assertEquals(SwiggyPollKind.FAILED, expired.kind)
        assertEquals(SWIGGY_SIGN_IN_EXPIRED, expired.message)
        assertEquals(SwiggyPollKind.CONTINUE, advanceSwiggyPoll(deadline - 1, deadline, null).kind)
        val timedOut = advanceSwiggyPoll(deadline, deadline, null)
        assertEquals(SwiggyPollKind.TIMED_OUT, timedOut.kind)
        assertEquals(SWIGGY_SIGN_IN_TIMED_OUT, timedOut.message)
        val lateSuccess = advanceSwiggyPoll(deadline + 1_200, deadline, SwiggyAuthStatus("connected", expiresAt = deadline))
        assertEquals(SwiggyPollKind.CONNECTED, lateSuccess.kind)
    }

    @Test
    fun parsesStatusAndRejectsANonHttpsAuthorizationUrl() {
        val status = parseSwiggyAuthStatus("""{"status":"failed","error":"Swiggy returned an incomplete OAuth response"}""")
        assertEquals("failed", status?.status)
        assertEquals("Swiggy returned an incomplete OAuth response", status?.error)
        val startBody = """{"authorizationUrl":"https://accounts.swiggy.com/oauth/authorize?state=abc","expiresAt":1700000600000}"""
        assertEquals("https://accounts.swiggy.com/oauth/authorize?state=abc", parseSwiggyAuthStart(startBody)?.authorizationUrl)
        assertNull(parseSwiggyAuthStart("""{"authorizationUrl":"javascript:alert(1)","expiresAt":1}"""))
        assertFalse(isSwiggyAuthorizationUrl("http://evil.example/authorize"))
        assertTrue(isSwiggyAuthorizationUrl("http://127.0.0.1:8787/api/swiggy/auth/callback"))
        assertNull(parseSwiggyAuthStatus("not json"))
    }
}
