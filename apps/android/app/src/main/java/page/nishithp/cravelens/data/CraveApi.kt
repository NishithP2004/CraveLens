package page.nishithp.cravelens.data

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import page.nishithp.cravelens.core.api.AuthorizedCaller
import page.nishithp.cravelens.core.api.DeviceSessionKeeper
import page.nishithp.cravelens.core.api.DeviceSessionStore
import page.nishithp.cravelens.core.api.HttpResult
import page.nishithp.cravelens.core.api.RefreshOutcome
import page.nishithp.cravelens.core.api.noRetryClient
import page.nishithp.cravelens.core.api.parseDeviceSession
import page.nishithp.cravelens.core.model.DeviceSession
import java.util.concurrent.TimeUnit

data class ApiResult(val ok: Boolean, val code: Int, val body: String)

fun serverError(result: ApiResult): String {
    val message = Regex(""""error"\s*:\s*"([^"\\]*)"""").find(result.body)?.groupValues?.get(1)
    return message?.takeIf { it.isNotBlank() } ?: "Request failed (${result.code})"
}

class CraveApi(val baseUrl: String, store: DeviceSessionStore) {
    private val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
    private val noRetry = noRetryClient()
    private val sessions = DeviceSessionKeeper(store, ::createSession, ::refreshSession)
    private val caller = AuthorizedCaller(sessions, ::send)

    fun deviceIdPrefix(): String? = sessions.deviceId?.take(8)?.takeIf { it.isNotEmpty() }

    suspend fun bearer(): String = sessions.bearer()

    suspend fun ensureSession(): String? = try {
        sessions.bearer()
        null
    } catch (error: Exception) {
        error.message?.takeIf { it.isNotBlank() } ?: "Device session failed"
    }

    suspend fun get(path: String): String {
        val result = call("GET", path, null)
        return if (result.ok) result.body.ifBlank { "Empty response" } else serverError(result)
    }

    suspend fun post(path: String, json: String): ApiResult = call("POST", path, json)

    suspend fun delete(path: String): ApiResult = call("DELETE", path, null)

    suspend fun decision(threadId: String, method: String): String {
        val token = try {
            sessions.bearer()
        } catch (_: Exception) {
            return "Sign in on this device before checkout."
        }
        val body = """{"decision":"approve","paymentMethod":"$method"}"""
        return try {
            execute(noRetry, token, "POST", "/api/orchestrate/$threadId/decision", body).body
        } catch (error: Exception) {
            "Checkout is uncertain. Check Swiggy before trying again. ${error.message?.substringBefore('\n')}"
        }
    }

    private suspend fun call(method: String, path: String, json: String?): ApiResult {
        val result = try {
            caller.call(method, path, json)
        } catch (error: Exception) {
            return ApiResult(false, 0, error.message ?: "Sign in on this device before this can load.")
        }
        return ApiResult(result.ok, result.code, result.body)
    }

    private suspend fun send(token: String, method: String, path: String, body: String?): HttpResult =
        execute(client, token, method, path, body)

    private suspend fun createSession(): DeviceSession {
        val result = execute(client, null, "POST", "/api/device/session", "{}")
        val session = parseDeviceSession(result.body)
        if (result.ok && session != null) return session
        throw IllegalStateException(if (result.ok) "Device session response did not include a device id" else "Device session failed (${result.code})")
    }

    private suspend fun refreshSession(token: String): RefreshOutcome {
        val body = buildJsonObject { put("refreshToken", JsonPrimitive(token)) }.toString()
        val result = execute(client, null, "POST", "/api/device/session/refresh", body)
        val session = parseDeviceSession(result.body)
        return when {
            result.ok && session != null -> RefreshOutcome.Rotated(session)
            result.code == 401 || result.code == 403 -> RefreshOutcome.Rejected
            else -> throw IllegalStateException("Device session refresh failed (${result.code})")
        }
    }

    private fun execute(http: OkHttpClient, token: String?, method: String, path: String, json: String?): HttpResult {
        val builder = Request.Builder().url("$baseUrl$path")
        if (token != null) builder.header("Authorization", "Bearer $token").header("X-CraveLens-Platform", "android")
        val request = when (method) {
            "GET" -> builder.get().build()
            "DELETE" -> builder.delete().build()
            else -> builder.method(method, json.orEmpty().toRequestBody("application/json".toMediaType())).build()
        }
        val response = http.newCall(request).execute()
        return HttpResult(response.code, response.body?.string().orEmpty())
    }
}
