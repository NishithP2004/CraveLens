package page.nishithp.cravelens.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.BubbleChart
import androidx.compose.material.icons.outlined.Gesture
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalFloatingToolbar
import androidx.compose.material3.Icon
import androidx.compose.material3.LargeFlexibleTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.ButtonGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import page.nishithp.cravelens.R
import page.nishithp.cravelens.data.CravePrefs
import page.nishithp.cravelens.ui.theme.Coral
import page.nishithp.cravelens.ui.theme.Ink
import page.nishithp.cravelens.ui.theme.Lime

enum class Dest { Home, Cart, History, Settings }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(title: String, subtitle: String? = null, content: @Composable (PaddingValues) -> Unit) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            LargeFlexibleTopAppBar(
                title = { Text(title) },
                subtitle = subtitle?.let { { Text(it) } },
                scrollBehavior = scroll,
            )
        },
        content = content,
    )
}

@Composable
fun OnboardingScreen(firebaseStatus: String, onFinished: (String) -> Unit) {
    val pages = listOf(
        "See it. Crave it." to "CraveLens spots food on your screen and prepares a Swiggy cart you can review. Nothing is ordered until you confirm.",
        "Frames stay on your phone." to "Frames never leave your phone unless you allow cloud help. The CraveLens server receives the dish description, not the picture.",
        "You confirm every order." to "Nothing is ordered until you confirm. Carts at or above ₹1,000 stay closed, and an order is never retried automatically.",
    )
    var page by rememberSaveable { mutableIntStateOf(0) }
    var fallback by rememberSaveable { mutableStateOf("ask") }
    val haptic = LocalHapticFeedback.current
    val motion = motionSpecs()
    ScreenScaffold("CraveLens", "On-device · Swiggy when you say so") { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (page < pages.size) {
                AnimatedContent(page, transitionSpec = { fadeIn(motion.effects) togetherWith fadeOut(motion.fast) }, label = "onboarding") { index ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(pages[index].first, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
                        Text(pages[index].second, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                BrandButton(if (page == pages.lastIndex) "Set up permissions" else "Continue") {
                    haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                    page += 1
                }
            } else {
                Text("When on-device identification can't run", style = MaterialTheme.typography.titleMedium)
                Text("Ask before using a hosted model is the default. The same choice is used when the local cart model fails.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                FallbackSegments(fallback) { fallback = it }
                ListItem(headlineContent = { Text("Firebase") }, supportingContent = { Text(firebaseStatus) })
                Text("Notifications, display over other apps, and screen capture are requested when you start watching. MediaProjection consent is per session.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                BrandButton("Save settings →") {
                    haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                    onFinished(fallback)
                }
            }
        }
    }
}

@Composable
private fun FallbackSegments(selected: String, onSelect: (String) -> Unit) {
    val options = listOf("auto" to "Automatically use a hosted model", "ask" to "Ask before using a hosted model", "none" to "Stop without switching models")
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, label) ->
            Surface(
                onClick = { onSelect(value) },
                shape = MaterialTheme.shapes.large,
                color = if (selected == value) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Text(label, modifier = Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    status: BubbleStatus,
    detail: String,
    showStatePreview: Boolean,
    shared: SharedTransitionScope,
    animated: androidx.compose.animation.AnimatedVisibilityScope,
    onWatch: () -> Unit,
    onLasso: () -> Unit,
    onBubble: () -> Unit,
    onOpenCart: () -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    val motion = motionSpecs()
    ScreenScaffold("Home", "CraveLens works quietly until it finds something delicious.") { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item {
                with(shared) {
                    Surface(
                        onClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.ContextClick)
                            onOpenCart()
                        },
                        modifier = Modifier.sharedBounds(
                            rememberSharedContentState("status-card"),
                            animatedVisibilityScope = animated,
                            boundsTransform = { _, _ -> motion.spatial },
                        ),
                        shape = MaterialTheme.shapes.extraLarge,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                    ) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(status.label, style = MaterialTheme.typography.titleMedium)
                            BubbleFace(status, detail)
                            Text("Open the cart", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
            item {
                BrandButton(if (status == BubbleStatus.WATCHING) "Watching" else "Start watching") {
                    haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                    onWatch()
                }
                ButtonGroup(overflowIndicator = { menuState ->
                    TextButton(onClick = { if (menuState.isShowing) menuState.dismiss() else menuState.show() }) { Text("More") }
                }) {
                    clickableItem(
                        onClick = { haptic.performHapticFeedback(HapticFeedbackType.ContextClick); onLasso() },
                        label = "Lasso",
                        icon = { Icon(Icons.Outlined.Gesture, contentDescription = "Lasso") },
                        weight = 1f,
                    )
                    clickableItem(
                        onClick = { haptic.performHapticFeedback(HapticFeedbackType.ContextClick); onBubble() },
                        label = "Bubble",
                        icon = { Icon(Icons.Outlined.BubbleChart, contentDescription = "Show floating bubble") },
                        weight = 1f,
                    )
                }
            }
            if (showStatePreview) {
                item {
                    Text("Bubble design preview", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                    Text("These faces are the status designs, not a live detection. The bubble above is the real state.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                items(listOf(BubbleStatus.SPOTTED, BubbleStatus.PERSONALIZING, BubbleStatus.PREPARING, BubbleStatus.READY)) { preview ->
                    BubbleFace(preview, preview.label)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalMaterial3Api::class)
@Composable
fun CartScreen(
    state: String,
    amountLabel: String,
    blocked: Boolean,
    shared: SharedTransitionScope?,
    animated: androidx.compose.animation.AnimatedVisibilityScope?,
    onRefresh: () -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    val motion = motionSpecs()
    val loading = state.startsWith("Loading")
    val failed = state.startsWith("Request failed") || state.startsWith("Sign in") || state.startsWith("Device session")
    val images = imageUrlsIn(state)
    Box(Modifier.fillMaxSize()) {
        ScreenScaffold("Cart", "Review before anything is ordered") { padding ->
            Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val cardMod = if (shared != null && animated != null) {
                    with(shared) {
                        Modifier.sharedBounds(rememberSharedContentState("status-card"), animatedVisibilityScope = animated, boundsTransform = { _, _ -> motion.spatial })
                    }
                } else Modifier
                Surface(cardMod.fillMaxWidth(), shape = MaterialTheme.shapes.extraLarge, color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            when {
                                loading -> "Checking"
                                images.isNotEmpty() -> "Looks delicious"
                                else -> "Nothing waiting"
                            },
                            style = MaterialTheme.typography.headlineSmall,
                            modifier = Modifier.semantics { heading() },
                        )
                        if (loading) {
                            LoadingIndicator(color = Coral)
                            Text("Checking the active cart")
                        }
                        if (images.isEmpty() && !loading) {
                            Image(painterResource(R.drawable.ill_empty_plate), contentDescription = "Empty plate illustration", modifier = Modifier.heightIn(max = 120.dp))
                        } else {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(images) { url ->
                                    AsyncImage(
                                        model = url,
                                        contentDescription = "Image returned with the cart",
                                        modifier = Modifier.size(72.dp).clip(RoundedCornerShape(16.dp)),
                                        contentScale = ContentScale.Crop,
                                    )
                                }
                            }
                        }
                        Text(state, style = MaterialTheme.typography.bodyLarge)
                        Text("Why this cart?", style = MaterialTheme.typography.labelLarge)
                        Text(amountLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (failed) Text("This is the server's reply. Nothing was invented in its place.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (blocked) Text("Builders Club carts must be under ₹1,000", color = MaterialTheme.colorScheme.error)
                    }
                }
                Text("Dismiss keeps the cart. Ordering needs Order, a payment method, and a press-and-hold confirmation. There is no Order action on notifications.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SpacerForToolbar()
            }
        }
        HorizontalFloatingToolbar(
            expanded = true,
            modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
            floatingActionButton = {
                FloatingActionButton(onClick = { haptic.performHapticFeedback(HapticFeedbackType.Confirm); onRefresh() }, containerColor = Lime, contentColor = Ink) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Check the active cart")
                }
            },
        ) {
            TextButton(onClick = {}, enabled = false) { Text(if (blocked) "Order unavailable" else "Order") }
        }
    }
}

@Composable
private fun SpacerForToolbar() {
    Box(Modifier.heightIn(min = 88.dp))
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(state: String, onRefresh: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    val loading = state.startsWith("Loading")
    val images = imageUrlsIn(state)
    ScreenScaffold("History", "What you already loved") { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (loading) LoadingIndicator(color = Coral)
            if (images.isEmpty() && !loading) {
                Image(painterResource(R.drawable.ill_empty_plate), contentDescription = "Empty plate illustration")
                Text(state, style = MaterialTheme.typography.bodyLarge)
            } else {
                images.forEach { url ->
                    AsyncImage(model = url, contentDescription = "Image returned with an order", modifier = Modifier.size(72.dp).clip(RoundedCornerShape(16.dp)), contentScale = ContentScale.Crop)
                }
                Text(state, style = MaterialTheme.typography.bodyLarge)
            }
            BrandButton("Load from Swiggy") {
                haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                onRefresh()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(prefs: CravePrefs, message: String, onChange: (CravePrefs) -> Unit, onSave: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    ScreenScaffold("Settings", "The same choices as the extension") { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(bottom = 32.dp)) {
            item { SectionLabel("01 Personal context") }
            item {
                androidx.compose.material3.OutlinedTextField(
                    value = prefs.personalContext,
                    onValueChange = { onChange(prefs.copy(personalContext = it)) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    label = { Text("Food preferences and routines") },
                    supportingText = { Text("Empty until you write them. Delivery address loads from Swiggy after a session.") },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
            }
            item { ListItem(headlineContent = { Text("History & evidence") }, supportingContent = { Text("Shown only from orders this device actually loads.") }) }
            item { SectionLabel("02 Detection context") }
            item { SliderRow("Food sensitivity", prefs.sensitivity, 0.35f, 0.8f, 44) { onChange(prefs.copy(sensitivity = it)) } }
            item { SliderRow("Model scan interval", prefs.scanIntervalMs / 1000f, 1f, 30f, 28) { onChange(prefs.copy(scanIntervalMs = (it.toInt().coerceIn(1, 30)) * 1000)) } }
            item {
                ListItem(
                    headlineContent = { Text("Debug overlay") },
                    supportingContent = { Text(if (prefs.debugOverlay) "Saved on. This build does not draw detection boxes yet." else "Off") },
                    trailingContent = { Switch(checked = prefs.debugOverlay, onCheckedChange = { haptic.performHapticFeedback(HapticFeedbackType.ToggleOn); onChange(prefs.copy(debugOverlay = it)) }) },
                )
            }
            item { SectionLabel("03 VLM configuration") }
            item { ListItem(headlineContent = { Text("Frame verification model") }, supportingContent = { Text("Auto · on-device first") }) }
            item {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    Text("When on-device identification can't run", style = MaterialTheme.typography.bodyMedium)
                    ShortSegments(listOf("auto", "ask", "none"), prefs.hostedFallback) { onChange(prefs.copy(hostedFallback = it)) }
                }
            }
            item { SectionLabel("04 Agentic orchestration") }
            item { ListItem(headlineContent = { Text("Cart reasoning model") }, supportingContent = { Text("Auto · Gemini Nano 4 first") }) }
            item { ListItem(headlineContent = { Text("Gemini Nano 4 model") }, supportingContent = { Text("Nano 4 Fast · faster") }) }
            item { SliderRow("Context length", prefs.contextTokens / 1024f, 4f, 32f, 6) { onChange(prefs.copy(contextTokens = (it.toInt().coerceIn(4, 32)) * 1024)) } }
            item {
                ListItem(
                    headlineContent = { Text("Thinking mode") },
                    supportingContent = { Text(if (prefs.thinking) "On" else "Off") },
                    trailingContent = { Switch(checked = prefs.thinking, onCheckedChange = { haptic.performHapticFeedback(HapticFeedbackType.ToggleOn); onChange(prefs.copy(thinking = it)) }) },
                )
            }
            item {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Text("When the local cart model fails")
                    ShortSegments(listOf("auto", "ask", "none"), prefs.hostedFallback) { onChange(prefs.copy(hostedFallback = it)) }
                }
            }
            item { SectionLabel("05 Cart experience") }
            item {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    Text("While you watch")
                    ShortSegments(listOf("screen", "nudge", "telegram"), prefs.cartExperience) { onChange(prefs.copy(cartExperience = it)) }
                }
            }
            item { ListItem(headlineContent = { Text("Connect Telegram") }, supportingContent = { Text("The Start link opens after this device has a session.") }) }
            item {
                ListItem(
                    headlineContent = { Text("Silent Telegram messages") },
                    supportingContent = { Text(if (prefs.telegramSilent) "On" else "Off") },
                    trailingContent = { Switch(checked = prefs.telegramSilent, onCheckedChange = { haptic.performHapticFeedback(HapticFeedbackType.ToggleOn); onChange(prefs.copy(telegramSilent = it)) }) },
                )
            }
            item { SectionLabel("Appearance") }
            item {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    Text("Theme")
                    ShortSegments(listOf("system", "light", "dark"), prefs.themeMode) { onChange(prefs.copy(themeMode = it)) }
                }
            }
            item {
                ListItem(
                    headlineContent = { Text("Use wallpaper colours") },
                    supportingContent = { Text("Android 12 and later. Coral and lime stay on the bubble and primary actions.") },
                    trailingContent = { Switch(checked = prefs.dynamicColor, onCheckedChange = { haptic.performHapticFeedback(HapticFeedbackType.ToggleOn); onChange(prefs.copy(dynamicColor = it)) }) },
                )
            }
            item { SectionLabel("06 Local AI setup") }
            item { ListItem(headlineContent = { Text("Gemini Nano through Firebase AI Logic") }, supportingContent = { Text(message) }) }
            item { ListItem(headlineContent = { Text("LiteRT Gemma 4 download is optional") }, supportingContent = { Text("Background turns stay unavailable until a model file is present.") }) }
            item {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    BrandButton("Save settings →") {
                        haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                        onSave()
                    }
                    TextButton(onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.ToggleOff)
                        onChange(prefs.copy(sensitivity = 0.38f, scanIntervalMs = 1000))
                    }) { Text("Reset detection defaults") }
                    Text("Scan current frame is available after a capture session.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, modifier = Modifier.padding(start = 16.dp, top = 20.dp, bottom = 4.dp), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun SliderRow(label: String, value: Float, min: Float, max: Float, steps: Int, onChange: (Float) -> Unit) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        Text("$label ${if (label.startsWith("Model")) "${value.toInt()} s" else if (label.startsWith("Context")) "${(value * 1024).toInt()}" else String.format("%.2f", value)}")
        Slider(value = value, onValueChange = onChange, valueRange = min..max, steps = steps)
    }
}

@Composable
private fun ShortSegments(options: List<String>, selected: String, onSelect: (String) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        options.forEachIndexed { index, option ->
            SegmentedButton(
                selected = selected == option,
                onClick = { onSelect(option) },
                shape = SegmentedButtonDefaults.itemShape(index, options.size),
            ) { Text(option) }
        }
    }
}

@Composable
fun BrandButton(text: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Coral, contentColor = Color.White),
    ) { Text(text) }
}

@Composable
fun SharedShell(dest: Dest, content: @Composable SharedTransitionScope.(androidx.compose.animation.AnimatedVisibilityScope) -> Unit) {
    val motion = motionSpecs()
    SharedTransitionLayout {
        val shared = this
        AnimatedContent(dest, transitionSpec = { fadeIn(motion.effects) togetherWith fadeOut(motion.fast) }, label = "dest") {
            shared.content(this)
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun motionSpecs(): MotionSpecs {
    val scheme = MaterialTheme.motionScheme
    return MotionSpecs(scheme.defaultEffectsSpec(), scheme.fastEffectsSpec(), scheme.defaultSpatialSpec())
}

private data class MotionSpecs(
    val effects: FiniteAnimationSpec<Float>,
    val fast: FiniteAnimationSpec<Float>,
    val spatial: FiniteAnimationSpec<Rect>,
)
