package page.nishithp.cravelens.core.sampler

enum class ThermalLevel { NONE, MODERATE, SEVERE }

class AdaptiveSampler(private val clock: () -> Long = System::currentTimeMillis) {
    private var burstUntil = 0L
    private var negativeSince = 0L

    fun nextDelayMs(
        score: Float?,
        threshold: Float,
        scanIntervalMs: Long,
        thermal: ThermalLevel,
        batterySaver: Boolean,
        screenOff: Boolean,
        now: Long = clock(),
    ): Long? {
        if (screenOff || thermal == ThermalLevel.SEVERE) return null
        if (score != null && score >= 0.25f && score < threshold) burstUntil = now + 5_000
        if (score != null && score >= threshold) negativeSince = 0L
        if (score == null || score < 0.25f) {
            if (negativeSince == 0L) negativeSince = now
        } else negativeSince = 0L
        val slow = negativeSince != 0L && now - negativeSince >= 20_000
        val desired = when {
            thermal >= ThermalLevel.MODERATE || batterySaver || slow -> 2_000L
            now < burstUntil -> 500L
            else -> 1_000L
        }
        return maxOf(scanIntervalMs, desired)
    }
}

class NudgeRateLimiter(
    private val minIntervalMs: Long = 10 * 60_000,
    private val maxPerHour: Int = 4,
    private val quietStartMinute: Int? = null,
    private val quietEndMinute: Int? = null,
) {
    private val stamps = ArrayDeque<Long>()

    fun allow(now: Long, minuteOfDay: Int? = null): Boolean {
        if (minuteOfDay != null && quietStartMinute != null && quietEndMinute != null && inQuietHours(minuteOfDay)) return false
        while (stamps.isNotEmpty() && now - stamps.first() >= 60 * 60_000) stamps.removeFirst()
        if (stamps.size >= maxPerHour) return false
        if (stamps.isNotEmpty() && now - stamps.last() < minIntervalMs) return false
        stamps.addLast(now)
        return true
    }

    private fun inQuietHours(minute: Int): Boolean {
        val start = quietStartMinute ?: return false
        val end = quietEndMinute ?: return false
        return if (start <= end) minute in start until end else minute >= start || minute < end
    }
}

class CartBuildLock {
    private val keys = mutableSetOf<String>()
    fun tryAcquire(source: String, dishKey: String): Boolean = keys.add("$source\u001f$dishKey")
    fun release(source: String, dishKey: String) { keys.remove("$source\u001f$dishKey") }
    fun holds(source: String, dishKey: String) = keys.contains("$source\u001f$dishKey")
}
