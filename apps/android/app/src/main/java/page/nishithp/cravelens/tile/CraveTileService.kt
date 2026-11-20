package page.nishithp.cravelens.tile

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import page.nishithp.cravelens.capture.ProjectionConsentActivity
import page.nishithp.cravelens.lasso.LassoActivity
import page.nishithp.cravelens.ui.BubbleStatus
import page.nishithp.cravelens.ui.WatchState

class CraveTileService : TileService() {
    override fun onStartListening() {
        qsTile.state = if (WatchState.status == BubbleStatus.WATCHING) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        qsTile.subtitle = when (WatchState.status) {
            BubbleStatus.WATCHING -> "Watching"
            BubbleStatus.READY -> "Cart ready"
            else -> "Off"
        }
        qsTile.updateTile()
    }

    override fun onClick() {
        val target = if (WatchState.status == BubbleStatus.WATCHING) LassoActivity::class.java else ProjectionConsentActivity::class.java
        val intent = Intent(this, target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(this, 7, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(pending) else @Suppress("DEPRECATION") startActivityAndCollapse(intent)
    }
}
