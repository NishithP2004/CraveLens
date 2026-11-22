package page.nishithp.cravelens.core.api

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

fun ordersHistoryPath(addressId: String, limit: Int = 20): String? {
    val address = addressId.trim()
    if (address.isEmpty()) return null
    val bounded = limit.coerceIn(1, 20)
    val encoded = URLEncoder.encode(address, StandardCharsets.UTF_8)
    return "/api/orders?limit=$bounded&addressId=$encoded"
}
