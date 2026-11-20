package page.nishithp.cravelens.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun OnboardingScreen(firebaseStatus: String, onFinished: (String) -> Unit) {
    val pages = listOf(
        "See it. Crave it." to "CraveLens watches for food on your screen and prepares a Swiggy cart you can review. Nothing is ordered until you confirm.",
        "Frames stay on your phone" to "Frames never leave your phone unless you allow cloud help. The CraveLens server receives the dish description, not the picture.",
        "You confirm every order" to "Nothing is ordered until you confirm. Carts at or above ₹1,000 stay closed, and an order is never retried automatically.",
    )
    var page by rememberSaveable { mutableIntStateOf(0) }
    var fallback by rememberSaveable { mutableStateOf("ask") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("CraveLens", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.primary)
        if (page < pages.size) {
            Text(pages[page].first, style = MaterialTheme.typography.headlineSmall)
            Text(pages[page].second)
            Button(onClick = { page += 1 }, modifier = Modifier.fillMaxWidth()) { Text(if (page == pages.lastIndex) "Set up permissions" else "Continue") }
        } else {
            Text("When on-device identification can't run", style = MaterialTheme.typography.titleLarge)
            Text("Ask before using a hosted model is the default. The same choice is used when the local cart model fails.")
            listOf("auto" to "Automatically use a hosted model", "ask" to "Ask before using a hosted model", "none" to "Stop without switching models").forEach { (value, label) ->
                Row(Modifier.fillMaxWidth().clickable { fallback = value }, verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    RadioButton(selected = fallback == value, onClick = { fallback = value })
                    Text(label)
                }
            }
            Text("Firebase: $firebaseStatus")
            Text("Notifications, display over other apps, and screen capture are requested when you start watching. MediaProjection consent is per session.")
            Button(onClick = { onFinished(fallback) }, modifier = Modifier.fillMaxWidth()) { Text("Save settings →") }
        }
    }
}

@Composable
fun HomeScreen(
    status: BubbleStatus,
    detail: String,
    onWatch: () -> Unit,
    onLasso: () -> Unit,
    onSettings: () -> Unit,
    onHistory: () -> Unit,
    onCart: () -> Unit,
    onBubble: () -> Unit,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("CraveLens", style = MaterialTheme.typography.headlineMedium)
        Text("See it. Crave it. Get it.")
        BubbleFace(status, detail)
        Button(onClick = onWatch, modifier = Modifier.fillMaxWidth().height(64.dp)) { Text(if (status == BubbleStatus.WATCHING) "Watching" else "Start watching") }
        OutlinedButton(onClick = onLasso, modifier = Modifier.fillMaxWidth().height(64.dp)) { Text("Lasso") }
        OutlinedButton(onClick = onBubble, modifier = Modifier.fillMaxWidth()) { Text("Show floating bubble") }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onSettings) { Text("Settings") }
            TextButton(onClick = onCart) { Text("Cart") }
            TextButton(onClick = onHistory) { Text("Order history") }
        }
    }
}

@Composable
fun SettingsScreen(message: String, onSave: () -> Unit, onBack: () -> Unit) {
    val sections = listOf(
        "01 Personal context" to listOf("Delivery address", "Food preferences and routines", "History & evidence"),
        "02 Detection context" to listOf("Food sensitivity 0.38", "Model scan interval 1000 ms", "Tile & Quick Tap behavior", "Debug overlay off"),
        "03 VLM configuration" to listOf("Frame verification model: Auto · on-device first", "When on-device identification can't run: Ask before using a hosted model"),
        "04 Agentic orchestration" to listOf("Cart reasoning model: Auto · Gemini Nano 4 first", "Gemini Nano 4 model: Nano 4 Fast · faster", "Context length 16384", "Thinking mode off", "When the local cart model fails: Ask before using a hosted model"),
        "05 Cart experience" to listOf("While you watch: Show progress on screen", "Connect Telegram", "Silent Telegram messages off"),
        "06 On-device AI setup" to listOf("Gemini Nano through Firebase AI Logic", "LiteRT Gemma 4 download is optional", message),
    )
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Settings", style = MaterialTheme.typography.headlineMedium)
        sections.forEach { (title, lines) ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    lines.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        }
        Button(onClick = onSave, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Save settings →") }
        Text("Reset detection defaults")
        Text("Scan current frame")
    }
}

@Composable
fun CartScreen(state: String, amountLabel: String, blocked: Boolean, onRefresh: () -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Looks delicious", style = MaterialTheme.typography.headlineMedium)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(state)
                Text("Why this cart?")
                Text(amountLabel)
            }
        }
        if (blocked) Text("Builders Club carts must be under ₹1,000")
        Button(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth().height(64.dp)) { Text(if (blocked) "Order unavailable" else "Order") }
        OutlinedButton(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) { Text("Check the active cart") }
        Text("Dismiss keeps the cart. Ordering needs Order, a payment method, and a press-and-hold confirmation. There is no Order action on notifications.")
    }
}

@Composable
fun HistoryScreen(state: String, onRefresh: () -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Order history", style = MaterialTheme.typography.headlineMedium)
        Text(state)
        Button(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) { Text("Load from Swiggy") }
    }
}

@Composable
fun ScreenPadding(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(PaddingValues(0.dp))) { content() }
}
