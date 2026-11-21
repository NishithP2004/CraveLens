package page.nishithp.cravelens

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.content.ActivityNotFoundException
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.browser.customtabs.CustomTabsIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.ShoppingBag
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import page.nishithp.cravelens.data.AppPrefs
import page.nishithp.cravelens.data.CravePrefs
import page.nishithp.cravelens.lasso.LassoActivity
import page.nishithp.cravelens.notify.syncCartProgress
import page.nishithp.cravelens.overlay.BubbleController
import page.nishithp.cravelens.ui.BubbleStatus
import page.nishithp.cravelens.ui.CartScreen
import page.nishithp.cravelens.ui.Dest
import page.nishithp.cravelens.ui.HistoryScreen
import page.nishithp.cravelens.ui.HomeScreen
import page.nishithp.cravelens.ui.OnboardingScreen
import page.nishithp.cravelens.ui.SettingsScreen
import page.nishithp.cravelens.ui.SharedShell
import page.nishithp.cravelens.ui.WatchState
import page.nishithp.cravelens.ui.theme.CraveTheme
import page.nishithp.cravelens.widget.refreshWidget

class MainActivity : ComponentActivity() {
    private val api by lazy { craveApi() }
    private var deviceSession by mutableStateOf<String?>(null)
    private val preferences by lazy { page.nishithp.cravelens.data.PreferenceController(api, applicationContext, lifecycleScope) }
    private val swiggy by lazy {
        page.nishithp.cravelens.data.SwiggyAuthController(
            api,
            applicationContext,
            lifecycleScope,
            openAuthorization = { url ->
                try {
                    CustomTabsIntent.Builder().setShareState(CustomTabsIntent.SHARE_STATE_OFF).build().launchUrl(this, Uri.parse(url))
                    true
                } catch (_: ActivityNotFoundException) {
                    false
                }
            },
            onConnected = { preferences.afterSignIn() },
        )
    }
    private var cartState by mutableStateOf("No cart is waiting. Check the server when a watching session prepares one.")
    private var historyState by mutableStateOf("Order history loads from Swiggy after this device has a session and a delivery address.")
    private var settingsMessage by mutableStateOf(CraveLensApp.startupMessage)
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val openHome = intent?.action == "page.nishithp.cravelens.WATCH"
        setContent {
            val prefs by produceState<CravePrefs?>(null, this) {
                AppPrefs.flow(this@MainActivity).collect { value = it }
            }
            val current = prefs
            if (current == null) return@setContent
            CraveTheme(mode = current.themeMode, dynamicColor = current.dynamicColor) {
                CraveShell(
                    prefs = current,
                    openHome = openHome,
                    cartState = cartState,
                    historyState = historyState,
                    settingsMessage = settingsMessage,
                    onPrefs = { next ->
                        lifecycleScope.launch {
                            AppPrefs.update(this@MainActivity) { next }
                            WatchState.fallback = next.hostedFallback
                            refreshWidget(this@MainActivity)
                        }
                    },
                    onSave = {
                        settingsMessage = "Saved on this device. Server settings sync after a device session."
                        lifecycleScope.launch { refreshWidget(this@MainActivity) }
                    },
                    onWatch = ::startWatch,
                    onLasso = { startActivity(Intent(this, LassoActivity::class.java)) },
                    onBubble = ::showBubble,
                    onRefreshCart = ::loadCart,
                    onRefreshHistory = ::loadHistory,
                    preferences = preferences.ui,
                    onRebuildPreferences = preferences::rebuild,
                    onAcceptPreferences = preferences::acceptDraft,
                    onKeepPreferences = preferences::keepOriginal,
                    onHostedDecision = preferences::hostedDecision,
                    swiggy = swiggy.ui,
                    onConnectSwiggy = swiggy::connect,
                    onDisconnectSwiggy = swiggy::disconnect,
                    onRefreshSwiggy = swiggy::refresh,
                    deviceSession = deviceSession,
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        CraveLensApp.appOnTop = true
        swiggy.refresh()
        publishDeviceSession()
    }

    override fun onPause() {
        CraveLensApp.appOnTop = false
        super.onPause()
    }

    private fun publishDeviceSession() {
        if (!BuildConfig.DEBUG) return
        lifecycleScope.launch {
            withContext(Dispatchers.IO) { api.ensureSession() }
            deviceSession = api.deviceIdPrefix()?.let { "Debug · starts with $it" } ?: "Debug · not created yet"
        }
    }

    private fun startWatch() {
        if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
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

    private fun summaryLine(body: String): String {
        val message = Regex(""""message"\s*:\s*"([^"\\]*)"""").find(body)?.groupValues?.get(1)
        return when {
            !message.isNullOrBlank() -> message
            body.trim().startsWith("{") -> "A cart response arrived. Open Cart to review it."
            else -> body.take(180)
        }
    }

    private fun absorbProfile(body: String) {
        val profile = page.nishithp.cravelens.core.preferences.parseAttachedProfile(body) ?: return
        lifecycleScope.launch {
            AppPrefs.update(this@MainActivity) {
                it.copy(
                    inferredPreferences = profile.preferences,
                    inferredNotes = profile.notes,
                    inferredGeneratedAt = profile.generatedAt,
                    inferredAddressId = profile.addressId,
                    inferredMatched = profile.matched,
                    inferredChecked = profile.checked,
                    inferredIncomplete = profile.incomplete,
                )
            }
        }
    }

    private fun launch(empty: String, call: suspend () -> String) {
        lifecycleScope.launch {
            val text = withContext(Dispatchers.IO) {
                api.ensureSession() ?: call()
            }
            val body = text.ifBlank { empty }
            absorbProfile(body)
            if (cartState.startsWith("Loading")) {
                cartState = body
                AppPrefs.update(this@MainActivity) { it.copy(cartSummary = summaryLine(body)) }
                refreshWidget(this@MainActivity)
            }
            if (historyState.startsWith("Loading")) historyState = body
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun CraveShell(
    prefs: CravePrefs,
    openHome: Boolean,
    cartState: String,
    historyState: String,
    settingsMessage: String,
    onPrefs: (CravePrefs) -> Unit,
    onSave: () -> Unit,
    onWatch: () -> Unit,
    onLasso: () -> Unit,
    onBubble: () -> Unit,
    onRefreshCart: () -> Unit,
    onRefreshHistory: () -> Unit,
    preferences: page.nishithp.cravelens.data.PreferenceUiState,
    onRebuildPreferences: () -> Unit,
    onAcceptPreferences: () -> Unit,
    onKeepPreferences: () -> Unit,
    onHostedDecision: (Boolean) -> Unit,
    swiggy: page.nishithp.cravelens.data.SwiggyAuthUiState,
    onConnectSwiggy: () -> Unit,
    onDisconnectSwiggy: () -> Unit,
    onRefreshSwiggy: () -> Unit,
    deviceSession: String?,
) {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    var showOnboarding by androidx.compose.runtime.remember { mutableStateOf(!prefs.onboarded && !openHome) }
    var dest by androidx.compose.runtime.remember { mutableStateOf(Dest.Home) }
    var backProgress by androidx.compose.runtime.remember { mutableFloatStateOf(0f) }
    LaunchedEffect(prefs.watchLabel) {
        val status = BubbleStatus.entries.firstOrNull { it.label == prefs.watchLabel } ?: BubbleStatus.OFF
        syncCartProgress(context, status)
    }
    if (showOnboarding) {
        OnboardingScreen(settingsMessage, swiggy, onConnectSwiggy, onRefreshSwiggy) { fallback ->
            WatchState.fallback = fallback
            onPrefs(prefs.copy(onboarded = true, hostedFallback = fallback))
            showOnboarding = false
        }
        return
    }
    PredictiveBackHandler(dest != Dest.Home) { events: Flow<androidx.activity.BackEventCompat> ->
        try {
            events.collect { backProgress = it.progress }
            backProgress = 0f
            dest = Dest.Home
        } catch (_: CancellationException) {
            backProgress = 0f
        }
    }
    NavigationSuiteScaffold(
        navigationSuiteItems = {
            Dest.entries.forEach { item ->
                item(
                    selected = dest == item,
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.ContextClick)
                        dest = item
                    },
                    icon = { NavIcon(item, dest == item) },
                    label = { Text(item.name) },
                )
            }
        },
    ) {
        Box(Modifier.fillMaxSize().graphicsLayer {
            val scale = 1f - 0.04f * backProgress
            scaleX = scale
            scaleY = scale
        }) {
            SharedShell(dest) { animated ->
                when (dest) {
                    Dest.Home -> HomeScreen(WatchState.status, WatchState.detail, BuildConfig.DEBUG, this, animated, onWatch, onLasso, onBubble, { dest = Dest.Cart }, prefs, preferences, onRebuildPreferences, swiggy, onConnectSwiggy)
                    Dest.Cart -> CartScreen(cartState, "Payable amount appears after a verified cart.", blocked = false, this, animated, onRefreshCart)
                    Dest.History -> HistoryScreen(historyState, onRefreshHistory)
                    Dest.Settings -> SettingsScreen(prefs, settingsMessage, onPrefs, onSave, preferences, onRebuildPreferences, onAcceptPreferences, onKeepPreferences, onHostedDecision, swiggy, onConnectSwiggy, onDisconnectSwiggy, deviceSession)
                }
            }
        }
    }
}

@Composable
private fun NavIcon(dest: Dest, selected: Boolean) {
    val icon = when (dest) {
        Dest.Home -> if (selected) Icons.Filled.Home else Icons.Outlined.Home
        Dest.Cart -> if (selected) Icons.Filled.ShoppingBag else Icons.Outlined.ShoppingBag
        Dest.History -> if (selected) Icons.Filled.History else Icons.Outlined.History
        Dest.Settings -> if (selected) Icons.Filled.Settings else Icons.Outlined.Settings
    }
    Icon(icon, contentDescription = null)
}
