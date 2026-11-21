package page.nishithp.cravelens.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

object WatchState {
    var status by mutableStateOf(BubbleStatus.OFF)
    var detail by mutableStateOf("Off")
    var fallback: String = "ask"
}
