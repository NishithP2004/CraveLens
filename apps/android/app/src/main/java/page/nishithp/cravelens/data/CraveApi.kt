package page.nishithp.cravelens.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import page.nishithp.cravelens.core.api.noRetryClient
import java.util.concurrent.TimeUnit

data class ApiResult(val ok: Boolean, val code: Int, val body: String)

fun serverError(result: ApiResult): String {
    val message = Regex(""""error"\s*:\s*"([^"\\]*)"""").find(result.body)?.groupValues?.get(1)
    return message?.takeIf { it.isNotBlank() } ?: "Request failed (${result.code})"
}

class CraveApi(private val baseUrl: String) {
    private val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
    private val noRetry = noRetryClient()
    var accessToken: String? = null
        private set

    fun createSession(): String {
        val body = "{}".toRequestBody("application/json".toMediaType())
        val response = client.newCall(Request.Builder().url("$baseUrl/api/device/session").post(body).build()).execute()
        val text = response.body?.string().orEmpty()
        if (!response.isSuccessful) return "Device session failed (${response.code})"
        val token = Regex("\"accessToken\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1)
        accessToken = token
        val device = Regex("\"deviceId\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1)
        return if (device != null) "Device session ready" else "Device session response did not include a device id"
    }

    fun get(path: String): String {
        val result = call("GET", path, null)
        return if (result.ok) result.body.ifBlank { "Empty response" } else serverError(result)
    }

    fun post(path: String, json: String): ApiResult = call("POST", path, json)

    fun delete(path: String): ApiResult = call("DELETE", path, null)

    private fun call(method: String, path: String, json: String?): ApiResult {
        val token = accessToken ?: return ApiResult(false, 0, "Sign in on this device before this can load.")
        val builder = Request.Builder().url("$baseUrl$path").header("Authorization", "Bearer $token").header("X-CraveLens-Platform", "android")
        val request = when (method) {
            "GET" -> builder.get().build()
            "DELETE" -> builder.delete().build()
            else -> builder.method(method, json.orEmpty().toRequestBody("application/json".toMediaType())).build()
        }
        val response = client.newCall(request).execute()
        return ApiResult(response.isSuccessful, response.code, response.body?.string().orEmpty())
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
