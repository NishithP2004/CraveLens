package page.nishithp.cravelens.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import page.nishithp.cravelens.ui.theme.AnnouncementBar
import page.nishithp.cravelens.ui.theme.Coral
import page.nishithp.cravelens.ui.theme.CraveButton
import page.nishithp.cravelens.ui.theme.CraveSecondaryButton
import page.nishithp.cravelens.ui.theme.Eyebrow
import page.nishithp.cravelens.ui.theme.Ink
import page.nishithp.cravelens.ui.theme.Kicker
import page.nishithp.cravelens.ui.theme.Lime
import page.nishithp.cravelens.ui.theme.NightInk
import page.nishithp.cravelens.ui.theme.PaperCard
import page.nishithp.cravelens.ui.theme.StepCard

@Composable
fun OnboardingScreen(firebaseStatus: String, onFinished: (String) -> Unit) {
    val pages = listOf(
        Triple("See it.", "Crave it.", "CraveLens spots food on your screen and prepares a Swiggy cart you can review. Nothing is ordered until you confirm."),
        Triple("Frames stay", "on your phone.", "Frames never leave your phone unless you allow cloud help. The CraveLens server receives the dish description, not the picture."),
        Triple("You confirm", "every order.", "Nothing is ordered until you confirm. Carts at or above ₹1,000 stay closed, and an order is never retried automatically."),
    )
    var page by rememberSaveable { mutableIntStateOf(0) }
    var fallback by rememberSaveable { mutableStateOf("ask") }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        AnnouncementBar()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Eyebrow("On-device · Swiggy when you say so")
            if (page < pages.size) {
                AnimatedContent(page, transitionSpec = { (slideInHorizontally { it / 3 } + fadeIn()) togetherWith (slideOutHorizontally { -it / 4 } + fadeOut()) }, label = "onboarding") { index ->
                    val (lead, accent, body) = pages[index]
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(lead, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
                        Text(accent, style = MaterialTheme.typography.headlineLarge, color = Coral)
                        Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                CraveButton(if (page == pages.lastIndex) "Set up permissions" else "Continue", onClick = { page += 1 })
            } else {
                Kicker("When on-device identification can't run")
                Text("Ask before using a hosted model is the default. The same choice is used when the local cart model fails.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                listOf("auto" to "Automatically use a hosted model", "ask" to "Ask before using a hosted model", "none" to "Stop without switching models").forEach { (value, label) ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { fallback = value },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = fallback == value, onClick = { fallback = value })
                        Text(label, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                PaperCard {
                    Text("Firebase", style = MaterialTheme.typography.labelLarge)
                    Text(firebaseStatus, style = MaterialTheme.typography.bodyMedium)
                }
                Text("Notifications, display over other apps, and screen capture are requested when you start watching. MediaProjection consent is per session.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                CraveButton("Save settings →", onClick = { onFinished(fallback) })
            }
        }
    }
}

@Composable
fun HomeScreen(
    status: BubbleStatus,
    detail: String,
    showStatePreview: Boolean,
    onWatch: () -> Unit,
    onLasso: () -> Unit,
    onSettings: () -> Unit,
    onHistory: () -> Unit,
    onCart: () -> Unit,
    onBubble: () -> Unit,
) {
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        AnnouncementBar()
        Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Kicker("See it. Crave it. Get it.")
            Text("Keep watching.", style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
            Text("CraveLens works quietly and only speaks up when it finds something delicious.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            PaperCard { BubbleFace(status, detail) }
            CraveButton(if (status == BubbleStatus.WATCHING) "Watching" else "Start watching", onClick = onWatch)
            CraveSecondaryButton("Lasso", onClick = onLasso)
            CraveSecondaryButton("Show floating bubble", onClick = onBubble)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onSettings, modifier = Modifier.heightIn(min = 48.dp)) { Text("Settings") }
                TextButton(onClick = onCart, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cart") }
                TextButton(onClick = onHistory, modifier = Modifier.heightIn(min = 48.dp)) { Text("Order history") }
            }
            if (showStatePreview) {
                Kicker("Bubble design preview")
                Text("These faces are the status designs, not a live detection. The bubble above is the real state.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                listOf(BubbleStatus.SPOTTED, BubbleStatus.PERSONALIZING, BubbleStatus.PREPARING, BubbleStatus.READY).forEach { preview ->
                    BubbleFace(preview, preview.label, pulse = preview == BubbleStatus.SPOTTED)
                }
            }
        }
    }
}

@Composable
fun SettingsScreen(message: String, onSave: () -> Unit, onBack: () -> Unit) {
    val sections = listOf(
        Triple("01", "Personal context", listOf("Delivery address", "Food preferences and routines", "History & evidence")),
        Triple("02", "Detection context", listOf("Food sensitivity 0.38", "Model scan interval 1000 ms", "Tile & Quick Tap behavior", "Debug overlay off")),
        Triple("03", "VLM configuration", listOf("Frame verification model: Auto · on-device first", "When on-device identification can't run: Ask before using a hosted model")),
        Triple("04", "Agentic orchestration", listOf("Cart reasoning model: Auto · Gemini Nano 4 first", "Gemini Nano 4 model: Nano 4 Fast · faster", "Context length 16384", "Thinking mode off", "When the local cart model fails: Ask before using a hosted model")),
        Triple("05", "Cart experience", listOf("While you watch: Show progress on screen", "Connect Telegram", "Silent Telegram messages off")),
        Triple("06", "On-device AI setup", listOf("Gemini Nano through Firebase AI Logic", "LiteRT Gemma 4 download is optional", message)),
    )
    val tones = listOf(Coral to Ink, Lime to Ink, Ink to NightInk)
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        AnnouncementBar()
        Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("Back") }
            Kicker("The same choices as the extension")
            Text("Settings", style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
            sections.forEachIndexed { index, (number, title, lines) ->
                val (tone, onTone) = tones[index % tones.size]
                StepCard(number, title, tone, onTone) {
                    lines.forEach { line ->
                        Text(line, color = onTone, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth())
                    }
                }
            }
            CraveButton("Save settings →", onClick = onSave)
            Text("Reset detection defaults", style = MaterialTheme.typography.bodyMedium)
            Text("Scan current frame", style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
fun CartScreen(state: String, amountLabel: String, blocked: Boolean, onRefresh: () -> Unit, onBack: () -> Unit) {
    val loading = state.startsWith("Loading")
    val failed = state.startsWith("Request failed") || state.startsWith("Sign in") || state.startsWith("Device session")
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("Back") }
        Kicker("Your match")
        Text("Looks delicious", style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
        PaperCard {
            if (loading) {
                CircularProgressIndicator(color = Coral)
                Text("Checking the active cart", style = MaterialTheme.typography.titleMedium)
            }
            Text(state, style = MaterialTheme.typography.bodyLarge)
            Text("Why this cart?", style = MaterialTheme.typography.labelLarge)
            Text(amountLabel, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (failed) Text("This is the server's reply. Nothing was invented in its place.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (blocked) Text("Builders Club carts must be under ₹1,000", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        CraveButton(if (blocked) "Order unavailable" else "Order", onClick = {}, enabled = false)
        CraveSecondaryButton("Check the active cart", onClick = onRefresh)
        Text("Dismiss keeps the cart. Ordering needs Order, a payment method, and a press-and-hold confirmation. There is no Order action on notifications.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun HistoryScreen(state: String, onRefresh: () -> Unit, onBack: () -> Unit) {
    val loading = state.startsWith("Loading")
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        AnnouncementBar()
        Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("Back") }
        Kicker("What you already loved")
        Text("Order history", style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
        PaperCard {
            if (loading) CircularProgressIndicator(color = Coral)
            Text(state, style = MaterialTheme.typography.bodyLarge)
        }
        CraveButton("Load from Swiggy", onClick = onRefresh)
        }
    }
}
