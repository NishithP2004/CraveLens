package page.nishithp.cravelens.overlay

import android.content.Context
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import page.nishithp.cravelens.ui.WatchState

object BubbleController {
    private var view: TextView? = null

    fun show(context: Context) {
        if (view != null) return
        val window = context.getSystemService(WindowManager::class.java)
        val bubble = TextView(context).apply {
            text = WatchState.detail
            setPadding(32, 32, 32, 32)
            setBackgroundColor(0xFFFF5B38.toInt())
            setTextColor(0xFFFFFFFF.toInt())
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_SECURE,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP or Gravity.START; x = 24; y = 240 }
        window.addView(bubble, params)
        view = bubble
    }

    fun hide(context: Context) {
        val bubble = view ?: return
        context.getSystemService(WindowManager::class.java).removeView(bubble)
        view = null
    }
}
