package page.nishithp.cravelens.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import page.nishithp.cravelens.core.model.PreferenceDraft
import page.nishithp.cravelens.core.model.PreferenceHistory
import page.nishithp.cravelens.core.model.PreferenceJob
import page.nishithp.cravelens.core.preferences.EMPTY_HISTORY_LIFETIME_MS
import page.nishithp.cravelens.core.preferences.PREFERENCE_PROFILE_LIFETIME_MS
import page.nishithp.cravelens.core.preferences.PreferenceTriggerReason
import page.nishithp.cravelens.core.preferences.SavedInferredProfile
import page.nishithp.cravelens.core.preferences.decidePreferenceBuild
import page.nishithp.cravelens.core.preferences.normalizePreferenceJob
import page.nishithp.cravelens.core.preferences.parseAttachedProfile
import page.nishithp.cravelens.core.preferences.parsePreferenceJob
import page.nishithp.cravelens.core.preferences.parseSavedAddresses

class PreferenceTriggerTest {
    private val now = 1_700_000_000_000L
    private val fresh = SavedInferredProfile("addr-1", "I like dosa", now - 1_000)

    @Test
    fun explicitContextSkipsAutomaticBuild() {
        val decision = decidePreferenceBuild("no peanuts", "addr-1", true, null, now, manual = false, connectionChanged = true)
        assertNull(decision.reason)
    }

    @Test
    fun manualNeedsAConnectedAddress() {
        assertEquals(
            "Select a delivery address before building preferences.",
            decidePreferenceBuild("", null, true, null, now, manual = true, connectionChanged = false).message,
        )
        assertEquals(
            "Reconnect your Swiggy account, select a delivery address, then build preferences again.",
            decidePreferenceBuild("", "addr-1", false, null, now, manual = true, connectionChanged = false).message,
        )
        assertEquals(
            PreferenceTriggerReason.MANUAL,
            decidePreferenceBuild("veg on Thursday", "addr-1", true, fresh, now, manual = true, connectionChanged = false).reason,
        )
    }

    @Test
    fun firstConnectedSessionBuildsWhenNothingIsSaved() {
        val decision = decidePreferenceBuild("", "addr-1", true, null, now, manual = false, connectionChanged = false)
        assertEquals(PreferenceTriggerReason.FIRST_AFTER_SIGN_IN, decision.reason)
    }

    @Test
    fun disconnectedSessionDoesNotBuildAutomatically() {
        assertNull(decidePreferenceBuild("", "addr-1", false, null, now, manual = false, connectionChanged = true).reason)
    }

    @Test
    fun freshProfileIsKeptUntilItIsStaleOrTheAddressChanges() {
        assertNull(decidePreferenceBuild("", "addr-1", true, fresh, now, manual = false, connectionChanged = false).reason)
        val stale = fresh.copy(generatedAt = now - PREFERENCE_PROFILE_LIFETIME_MS)
        assertEquals(PreferenceTriggerReason.STALE, decidePreferenceBuild("", "addr-1", true, stale, now, false, false).reason)
        assertEquals(PreferenceTriggerReason.ADDRESS_CHANGED, decidePreferenceBuild("", "addr-2", true, fresh, now, false, false).reason)
        assertEquals(PreferenceTriggerReason.FIRST_AFTER_SIGN_IN, decidePreferenceBuild("", "addr-1", true, fresh, now, false, true).reason)
    }

    @Test
    fun emptyHistoryUsesTheOneDayWindowAndUnreadableHistoryIsRebuilt() {
        val empty = SavedInferredProfile("addr-1", "", now - 1_000, checked = 0, incomplete = false)
        assertNull(decidePreferenceBuild("", "addr-1", true, empty, now, false, false).reason)
        val dayOld = empty.copy(generatedAt = now - EMPTY_HISTORY_LIFETIME_MS)
        assertEquals(PreferenceTriggerReason.STALE, decidePreferenceBuild("", "addr-1", true, dayOld, now, false, false).reason)
        val unreadable = empty.copy(checked = 3, incomplete = true)
        assertEquals(PreferenceTriggerReason.FIRST_AFTER_SIGN_IN, decidePreferenceBuild("", "addr-1", true, unreadable, now, false, false).reason)
    }

    @Test
    fun readyJobWithNoMatchedOrdersIsNoHistory() {
        val job = PreferenceJob(runId = "abc", status = "ready", result = PreferenceDraft(history = PreferenceHistory(matched = 0)))
        assertEquals("no_history", normalizePreferenceJob(job).status)
        val matched = job.copy(result = PreferenceDraft(preferences = "dosa", history = PreferenceHistory(matched = 2)))
        assertEquals("ready", normalizePreferenceJob(matched).status)
    }

    @Test
    fun parsesTheServerJobAndAddressList() {
        val job = parsePreferenceJob("""{"runId":"11111111-1111-1111-1111-111111111111","status":"running","progress":[{"message":"Reading recent Swiggy orders…","at":1}]}""")
        assertEquals("running", job?.status)
        assertEquals("Reading recent Swiggy orders…", job?.progress?.single()?.message)
        val addresses = parseSavedAddresses("""{"addresses":[{"id":"","addressString":"skip"},{"id":"addr-1","addressString":"12 Road","receiverName":"A"}]}""")
        assertEquals(1, addresses.size)
        assertEquals("addr-1", addresses.single().id)
        assertEquals("12 Road", addresses.single().addressString)
    }

    @Test
    fun readsAnAttachedProfileWithoutInventingOne() {
        val profile = parseAttachedProfile("""{"suggestion":{"preferenceProfile":{"addressId":"addr-1","preferences":"dosa","notes":"two orders","generatedAt":1700000000000,"history":{"matched":2,"checked":4,"incomplete":false}}}}""")
        assertEquals("dosa", profile?.preferences)
        assertEquals(2, profile?.matched)
        assertNull(parseAttachedProfile("""{"suggestion":{"items":[]}}"""))
    }
}
