package page.nishithp.cravelens.lasso

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import page.nishithp.cravelens.capture.FrameStore
import page.nishithp.cravelens.ui.theme.CraveTheme

class LassoActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val frame = FrameStore.freezeLatest()
        setContent {
            CraveTheme("system") {
                var path by mutableStateOf(Path())
                Box(Modifier.fillMaxSize().background(Color(0xE610110E))) {
                    if (frame == null) {
                        Column(Modifier.statusBarsPadding().padding(28.dp)) {
                            Text("LASSO", color = Color(0xFFD9ED72), style = androidx.compose.material3.MaterialTheme.typography.titleSmall)
                            Text("Circle the food", color = Color(0xFFFFF8EE), style = androidx.compose.material3.MaterialTheme.typography.headlineMedium)
                            Text("Start watching first for instant Lasso. There is no frozen frame from a capture session.", color = Color(0xFFB6B2A7), modifier = Modifier.padding(top = 8.dp))
                            Text("Tap anywhere to cancel", color = Color(0xFFFF5B38), modifier = Modifier.padding(top = 16.dp).pointerInput(Unit) { detectDragGestures { _, _ -> } })
                        }
                    }
                    Canvas(Modifier.fillMaxSize().pointerInput(frame) {
                        detectDragGestures(
                            onDragStart = { path = Path().apply { moveTo(it.x, it.y) } },
                            onDrag = { change, _ -> path = Path().apply { addPath(path); lineTo(change.position.x, change.position.y) } },
                        )
                    }) {
                        drawPath(path, Color(0xFFFF5B38), style = Stroke(width = 6f))
                    }
                }
            }
        }
    }
}

fun simplify(points: List<Offset>, epsilon: Float = 2f): List<Offset> {
    if (points.size < 3) return points
    return points
}
