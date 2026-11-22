package page.nishithp.cravelens.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import page.nishithp.cravelens.R
import page.nishithp.cravelens.ui.BubbleStatus

private const val CHANNEL = "cravelens-cart-progress"
private const val ID = 44

/**
 * Progress-centric notification for a real Preparing cart or Cart ready state.
 * API 36 uses [Notification.ProgressStyle]. Older versions use a determinate progress bar.
 * Nothing is posted for any other status, and there is no Order action.
 */
fun syncCartProgress(context: Context, status: BubbleStatus) {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (status != BubbleStatus.PREPARING && status != BubbleStatus.READY) {
        manager.cancel(ID)
        return
    }
    manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.cart_progress_channel), NotificationManager.IMPORTANCE_LOW))
    val ready = status == BubbleStatus.READY
    val title = if (ready) "Cart ready" else "Preparing cart"
    val text = "Review the cart before anything is ordered."
    val notification = if (Build.VERSION.SDK_INT >= 36) {
        val style = Notification.ProgressStyle()
            .setStyledByProgress(true)
            .setProgress(if (ready) 100 else 50)
            .setProgressSegments(
                listOf(
                    Notification.ProgressStyle.Segment(50).setColor(0xFFB52605.toInt()),
                    Notification.ProgressStyle.Segment(50).setColor(0xFFD9ED72.toInt()),
                ),
            )
        Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(!ready)
            .setStyle(style)
            .build()
    } else {
        Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(!ready)
            .setProgress(100, if (ready) 100 else 50, false)
            .build()
    }
    manager.notify(ID, notification)
}
