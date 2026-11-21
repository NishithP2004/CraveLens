package page.nishithp.cravelens.overlay

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import page.nishithp.cravelens.BuildConfig
import page.nishithp.cravelens.craveApi
import page.nishithp.cravelens.ui.WatchState

object BubbleController {
    private var view: LinearLayout? = null

    fun show(context: Context) {
        val session = context.craveApi()
        CoroutineScope(Dispatchers.IO).launch { session.ensureSession() }
        if (view != null) return
        val window = context.getSystemService(WindowManager::class.java)
        val density = context.resources.displayMetrics.density
        fun px(dp: Int) = (dp * density).toInt()
        val bubble = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(px(8), px(8), px(8), px(8))
            contentDescription = "CraveLens bubble, ${WatchState.detail}"
        }
        val mark = FrameLayout(context).apply {
            val size = px(68)
            layoutParams = LinearLayout.LayoutParams(size, size)
            addView(View(context).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.TRANSPARENT)
                    setStroke(px(3), Color.parseColor("#FF5B38"))
                }
            }, FrameLayout.LayoutParams(size, size, Gravity.CENTER))
            val inner = px(52)
            addView(TextView(context).apply {
                text = "CL"
                setTextColor(Color.parseColor("#FF5B38"))
                textSize = 16f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.parseColor("#FFFAF2"))
                    setStroke(px(2), Color.parseColor("#D9ED72"))
                }
            }, FrameLayout.LayoutParams(inner, inner, Gravity.CENTER))
        }
        val label = TextView(context).apply {
            text = WatchState.detail
            setTextColor(Color.parseColor("#181814"))
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(px(14), px(10), px(14), px(10))
            background = GradientDrawable().apply {
                cornerRadius = px(99).toFloat()
                setColor(Color.parseColor("#FFFAF2"))
                setStroke(px(1), Color.parseColor("#D9D1C2"))
            }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = px(10) }
        }
        bubble.addView(mark)
        bubble.addView(label)
        val secure = if (BuildConfig.DEBUG) 0 else WindowManager.LayoutParams.FLAG_SECURE
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or secure,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.BOTTOM or Gravity.END; x = px(16); y = px(96) }
        window.addView(bubble, params)
        view = bubble
    }

    fun hide(context: Context) {
        val bubble = view ?: return
        context.getSystemService(WindowManager::class.java).removeView(bubble)
        view = null
    }
}
