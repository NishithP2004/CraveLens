package page.nishithp.cravelens.capture

import android.graphics.Bitmap

object FrameStore {
    private val frames = ArrayDeque<Pair<Long, Bitmap>>()
    fun add(bitmap: Bitmap) {
        val copy = bitmap.copy(Bitmap.Config.ARGB_8888, false)
        frames.addLast(System.currentTimeMillis() to copy)
        while (frames.size > 4) frames.removeFirst().second.recycle()
    }
    fun freezeLatest(before: Long = System.currentTimeMillis() - 150): Bitmap? =
        frames.lastOrNull { it.first <= before }?.second ?: frames.lastOrNull()?.second
    fun clear() { frames.forEach { it.second.recycle() }; frames.clear() }
}
