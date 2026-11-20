package page.nishithp.cravelens.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import page.nishithp.cravelens.MainActivity
import page.nishithp.cravelens.R
import page.nishithp.cravelens.ui.BubbleStatus
import page.nishithp.cravelens.ui.WatchState

class CaptureService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            WatchState.status = BubbleStatus.OFF
            WatchState.detail = "Off"
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = watchingNotification()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(NOTICE_ID, notification)
        val resultCode = intent?.getIntExtra(EXTRA_CODE, 0) ?: 0
        val data = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java) else @Suppress("DEPRECATION") intent?.getParcelableExtra(EXTRA_DATA)
        if (data == null || resultCode == 0) {
            WatchState.status = BubbleStatus.ERROR
            WatchState.detail = "Screen capture consent was not granted"
            stopSelf()
            return START_NOT_STICKY
        }
        WatchState.status = BubbleStatus.WATCHING
        WatchState.detail = "Watching"
        return START_NOT_STICKY
    }

    private fun watchingNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Watching", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 1, Intent(this, CaptureService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(getString(R.string.watching_notification))
            .setContentText(getString(R.string.stop))
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, getString(R.string.stop), stop).build())
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL = "watching"
        private const val NOTICE_ID = 41
        private const val ACTION_STOP = "stop"
        private const val EXTRA_CODE = "code"
        private const val EXTRA_DATA = "data"
        fun start(context: Context, resultCode: Int, data: Intent) {
            val intent = Intent(context, CaptureService::class.java).putExtra(EXTRA_CODE, resultCode).putExtra(EXTRA_DATA, data)
            context.startForegroundService(intent)
        }
    }
}
