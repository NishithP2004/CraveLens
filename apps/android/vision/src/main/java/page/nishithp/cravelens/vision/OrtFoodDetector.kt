package page.nishithp.cravelens.vision

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import page.nishithp.cravelens.core.yolo.DetectionBox
import page.nishithp.cravelens.core.yolo.decodeOutput
import page.nishithp.cravelens.core.yolo.letterboxTransform
import page.nishithp.cravelens.core.yolo.mapBoxToUnit
import java.nio.FloatBuffer

class OrtFoodDetector(context: Context) {
    private val environment = OrtEnvironment.getEnvironment()
    private val session: OrtSession

    init {
        val bytes = context.assets.open("models/food-detector/best_dynamic.onnx").use { it.readBytes() }
        session = environment.createSession(bytes)
    }

    fun detect(bitmap: Bitmap, threshold: Float): List<DetectionBox> {
        val letterbox = letterboxTransform(bitmap.width, bitmap.height)
        val input = FloatArray(3 * 640 * 640)
        val scaled = Bitmap.createScaledBitmap(bitmap, kotlin.math.round(bitmap.width * letterbox.scale).toInt().coerceAtLeast(1), kotlin.math.round(bitmap.height * letterbox.scale).toInt().coerceAtLeast(1), true)
        val canvas = Bitmap.createBitmap(640, 640, Bitmap.Config.ARGB_8888)
        val paint = android.graphics.Canvas(canvas)
        paint.drawColor(android.graphics.Color.rgb(114, 114, 114))
        paint.drawBitmap(scaled, letterbox.x.toFloat(), letterbox.y.toFloat(), null)
        val pixels = IntArray(640 * 640)
        canvas.getPixels(pixels, 0, 640, 0, 0, 640, 640)
        val plane = 640 * 640
        for (index in pixels.indices) {
            val pixel = pixels[index]
            input[index] = ((pixel shr 16) and 0xff) / 255f
            input[plane + index] = ((pixel shr 8) and 0xff) / 255f
            input[plane * 2 + index] = (pixel and 0xff) / 255f
        }
        val tensor = OnnxTensor.createTensor(environment, FloatBuffer.wrap(input), longArrayOf(1, 3, 640, 640))
        session.run(mapOf(session.inputNames.first() to tensor)).use { result ->
            val output = result[0].value
            val (data, dims) = flatten(output)
            return decodeOutput(data, dims, threshold).map { mapBoxToUnit(it, letterbox) }
        }
    }

    private fun flatten(value: Any?): Pair<FloatArray, IntArray> {
        val array = value as Array<*>
        val rows = array[0] as Array<*>
        val channelFirst = rows[0] is FloatArray && (rows[0] as FloatArray).size > rows.size
        if (rows[0] is FloatArray && !channelFirst) {
            val count = rows.size
            val channels = (rows[0] as FloatArray).size
            val data = FloatArray(count * channels)
            rows.forEachIndexed { index, row -> (row as FloatArray).copyInto(data, index * channels) }
            return data to intArrayOf(1, count, channels)
        }
        val channels = rows.size
        val count = (rows[0] as FloatArray).size
        val data = FloatArray(channels * count)
        rows.forEachIndexed { channel, row -> (row as FloatArray).copyInto(data, channel * count) }
        return data to intArrayOf(1, channels, count)
    }
}
