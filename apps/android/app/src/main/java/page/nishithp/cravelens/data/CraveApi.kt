package page.nishithp.cravelens.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import page.nishithp.cravelens.core.api.noRetryClient
import java.util.concurrent.TimeUnit

class CraveApi(private val baseUrl: String) {
    private val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
    private val noRetry = noRetryClient()
    var accessToken: String? = null
        private set

    fun createSession(): String {
        val body = "{}".toRequestBody("application/json".toMediaType())
        val response = client.newCall(Request.Builder().url("$baseUrl/api/device/session").post(body).build()).execute()
        val text = response.body?.string().orEmpty()
        if (!response.isSuccessful) return "Device session failed (${response.code}): ${text.take(240)}"
        val token = Regex("\"accessToken\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1)
        accessToken = token
        val device = Regex("\"deviceId\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1)
        return if (device != null) "Device session ready" else "Device session response did not include a device id"
    }

    fun get(path: String): String {
        val token = accessToken ?: return "Sign in on this device before this can load."
        val request = Request.Builder().url("$baseUrl$path").header("Authorization", "Bearer $token").header("X-CraveLens-Platform", "android").get().build()
        val response = client.newCall(request).execute()
        val text = response.body?.string().orEmpty()
        return if (response.isSuccessful) text.ifBlank { "Empty response" } else "Request failed (${response.code}): ${text.take(400)}"
    }

    fun decision(threadId: String, method: String): String {
        val token = accessToken ?: return "Sign in on this device before checkout."
        val body = """{"decision":"approve","paymentMethod":"$method"}""".toRequestBody("application/json".toMediaType())
        val call = noRetry.newCall(Request.Builder().url("$baseUrl/api/orchestrate/$threadId/decision").header("Authorization", "Bearer $token").post(body).build())
        return try {
            val response = call.execute()
            response.body?.string().orEmpty()
        } catch (error: Exception) {
            "Checkout is uncertain. Check Swiggy before trying again. ${error.message}"
        }
    }
}
