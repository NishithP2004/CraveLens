package page.nishithp.cravelens.core.yolo

data class DetectionBox(
    val label: String,
    val score: Float,
    val x1: Float,
    val y1: Float,
    val x2: Float,
    val y2: Float,
)

data class Letterbox(val scale: Float, val x: Int, val y: Int, val sourceWidth: Int, val sourceHeight: Int)

fun letterboxTransform(sourceWidth: Int, sourceHeight: Int, inputSize: Int = 640): Letterbox {
    val scale = minOf(inputSize.toFloat() / sourceWidth, inputSize.toFloat() / sourceHeight)
    val width = kotlin.math.round(sourceWidth * scale).toInt()
    val height = kotlin.math.round(sourceHeight * scale).toInt()
    return Letterbox(scale, (inputSize - width) / 2, (inputSize - height) / 2, sourceWidth, sourceHeight)
}

fun mapBoxToUnit(box: DetectionBox, letterbox: Letterbox): DetectionBox {
    fun clamp(value: Float, maximum: Float) = value.coerceIn(0f, maximum)
    val width = letterbox.sourceWidth.toFloat()
    val height = letterbox.sourceHeight.toFloat()
    return box.copy(
        x1 = clamp((box.x1 - letterbox.x) / letterbox.scale, width) / width,
        y1 = clamp((box.y1 - letterbox.y) / letterbox.scale, height) / height,
        x2 = clamp((box.x2 - letterbox.x) / letterbox.scale, width) / width,
        y2 = clamp((box.y2 - letterbox.y) / letterbox.scale, height) / height,
    )
}

fun decodeOutput(data: FloatArray, dims: IntArray, threshold: Float, nmsIou: Float = 0.45f, maxBoxes: Int = 25): List<DetectionBox> {
    val batch = dims.getOrNull(0) ?: 0
    val first = dims.getOrNull(1) ?: 0
    val second = dims.getOrNull(2) ?: 0
    if (batch != 1 || first == 0 || second == 0) throw IllegalArgumentException("Unexpected detector output shape: ${dims.joinToString("×")}")
    val channelFirst = first < second
    val channels = if (channelFirst) first else second
    val count = if (channelFirst) second else first
    if (channels < 5) throw IllegalArgumentException("Detector output has only $channels channels")
    fun get(channel: Int, index: Int) = if (channelFirst) data[channel * count + index] else data[index * channels + channel]
    val candidates = mutableListOf<DetectionBox>()
    for (index in 0 until count) {
        var classIndex = 0
        var score = get(4, index)
        for (channel in 5 until channels) {
            val value = get(channel, index)
            if (value > score) {
                score = value
                classIndex = channel - 4
            }
        }
        if (score < threshold) continue
        val cx = get(0, index)
        val cy = get(1, index)
        val width = get(2, index)
        val height = get(3, index)
        candidates += DetectionBox(
            label = if (classIndex == 0) "food" else "food_${classIndex + 1}",
            score = score,
            x1 = cx - width / 2f,
            y1 = cy - height / 2f,
            x2 = cx + width / 2f,
            y2 = cy + height / 2f,
        )
    }
    candidates.sortByDescending { it.score }
    val kept = mutableListOf<DetectionBox>()
    for (candidate in candidates) {
        if (kept.all { intersectionOverUnion(candidate, it) < nmsIou }) kept += candidate
        if (kept.size >= maxBoxes) break
    }
    return kept
}

fun intersectionOverUnion(a: DetectionBox, b: DetectionBox): Float {
    val intersection = maxOf(0f, minOf(a.x2, b.x2) - maxOf(a.x1, b.x1)) * maxOf(0f, minOf(a.y2, b.y2) - maxOf(a.y1, b.y1))
    val areaA = maxOf(0f, a.x2 - a.x1) * maxOf(0f, a.y2 - a.y1)
    val areaB = maxOf(0f, b.x2 - b.x1) * maxOf(0f, b.y2 - b.y1)
    return intersection / maxOf(areaA + areaB - intersection, Float.MIN_VALUE)
}
