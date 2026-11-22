package page.nishithp.cravelens.ui

private val imagePattern = Regex(""""(?:imageUrl|thumbnailUrl|image_url|thumbnail_url)"\s*:\s*"(https://[^"\\]+)"""")

/** Image URLs present in a real cart or history response. An empty body yields none. */
fun imageUrlsIn(body: String): List<String> {
    val trimmed = body.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return emptyList()
    return imagePattern.findAll(body).map { it.groupValues[1] }.distinct().toList()
}
