package page.nishithp.cravelens

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import page.nishithp.cravelens.data.CraveApi
import page.nishithp.cravelens.lasso.LassoActivity
import page.nishithp.cravelens.overlay.BubbleController
import page.nishithp.cravelens.ui.BubbleStatus
import page.nishithp.cravelens.ui.CartScreen
import page.nishithp.cravelens.ui.HistoryScreen
import page.nishithp.cravelens.ui.HomeScreen
import page.nishithp.cravelens.ui.OnboardingScreen
import page.nishithp.cravelens.ui.SettingsScreen
import page.nishithp.cravelens.ui.WatchState
import page.nishithp.cravelens.ui.theme.CraveTheme

@OptIn(ExperimentalMaterial3Api::class)
class MainActivity : ComponentActivity() {
    private val api = CraveApi(BuildConfig.PROD_API_URL)
    private var route by mutableStateOf("onboarding")
    private var cartState by mutableStateOf("No cart is waiting. Check the server when a watching session prepares one.")
    private var historyState by mutableStateOf("Order history loads from Swiggy after this device has a session and a delivery address.")
    private var settingsMessage by mutableStateOf(CraveLensApp.startupMessage)
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        if (intent?.action == "page.nishithp.cravelens.WATCH") route = "home"
        setContent {
            CraveTheme(mode = "system") {
                val under = if (route == "cart") "home" else route
                Box {
                AnimatedContent(targetState = under, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "route") { screen ->
                    when (screen) {
                        "onboarding" -> OnboardingScreen(CraveLensApp.startupMessage) {
                            WatchState.fallback = it
                            route = "home"
                        }
                        "settings" -> SettingsScreen(settingsMessage, onSave = { settingsMessage = "Saved on this device. Server settings sync after a device session." }, onBack = { route = "home" })
                        "history" -> HistoryScreen(historyState, onRefresh = ::loadHistory, onBack = { route = "home" })
                        else -> HomeScreen(
                            status = WatchState.status,
                            detail = WatchState.detail,
                            showStatePreview = BuildConfig.DEBUG,
                            onWatch = ::startWatch,
                            onLasso = { startActivity(Intent(this@MainActivity, LassoActivity::class.java)) },
                            onSettings = { route = "settings" },
                            onHistory = { route = "history" },
                            onCart = { route = "cart" },
                            onBubble = ::showBubble,
                        )
                    }
                }
                if (route == "cart") {
                    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
                    ModalBottomSheet(
                        onDismissRequest = { route = "home" },
                        sheetState = sheetState,
                        containerColor = androidx.compose.material3.MaterialTheme.colorScheme.background,
                        shape = RoundedCornerShape(topStart = 26.dp, topEnd = 26.dp),
                        dragHandle = { BottomSheetDefaults.DragHandle() },
                    ) {
                        CartScreen(
                            cartState,
                            "Payable amount appears after a verified cart.",
                            blocked = false,
                            onRefresh = ::loadCart,
                            onBack = { route = "home" },
                        )
                    }
                }
                }
            }
        }
    }

    private fun startWatch() {
        if (!Settings.canDrawOverlays(this)) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        startActivity(Intent(this, page.nishithp.cravelens.capture.ProjectionConsentActivity::class.java))
    }

    private fun showBubble() {
        if (!Settings.canDrawOverlays(this)) {
            WatchState.detail = "Display over other apps is off. Notification mode still works."
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            return
        }
        BubbleController.show(this)
    }

    private fun loadCart() = launch("No active cart.") { api.get("/api/cart/active") }.also { cartState = "Loading the active cart…" }

    private fun loadHistory() = launch("No orders returned.") { api.get("/api/orders?limit=20") }.also { historyState = "Loading order history…" }

    private fun launch(empty: String, call: () -> String) {
        lifecycleScope.launch {
            val text = withContext(Dispatchers.IO) {
                if (api.accessToken == null) api.createSession()
                if (api.accessToken == null) return@withContext api.createSession()
                call()
            }
            if (route == "cart" || cartState.startsWith("Loading")) cartState = text.ifBlank { empty }
            if (route == "history" || historyState.startsWith("Loading")) historyState = text.ifBlank { empty }
        }
    }
}
