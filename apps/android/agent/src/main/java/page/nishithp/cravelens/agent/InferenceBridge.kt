package page.nishithp.cravelens.agent

import io.socket.client.IO
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import org.json.JSONObject
import page.nishithp.cravelens.core.agent.InferenceException
import page.nishithp.cravelens.core.json.CraveJson
import page.nishithp.cravelens.core.model.InferenceRequest
import page.nishithp.cravelens.core.model.InferenceResult
import page.nishithp.cravelens.core.routing.AgentRouteInput
import page.nishithp.cravelens.core.routing.AgentRuntime
import page.nishithp.cravelens.core.routing.HostedFallback
import page.nishithp.cravelens.core.routing.OrchestrationProvider
import page.nishithp.cravelens.core.routing.routeAgent
import java.net.URI

class InferenceBridge(
    private val aicore: AicoreChat,
    private val litert: LiteRtLmChat,
    private val cloud: FirebaseCloudChat,
    private val appOnTop: () -> Boolean,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private var socket: io.socket.client.Socket? = null

    fun connect(apiUrl: String, accessToken: String, providers: List<Map<String, Any?>>) {
        disconnect()
        val options = IO.Options().apply {
            path = "/socket.io/"
            transports = arrayOf("websocket")
            auth = mapOf("token" to accessToken)
            reconnection = true
        }
        val client = IO.socket(URI.create(apiUrl.trimEnd('/') + "/inference"), options)
        socket = client
        client.on(io.socket.client.Socket.EVENT_CONNECT) {
            client.emit("inference:register", JSONObject().put("version", 1).put("providers", org.json.JSONArray(providers.map { JSONObject(it) })))
        }
        client.on("inference:invoke") { args ->
            val payload = args.firstOrNull()?.toString() ?: return@on
            val acknowledge = args.getOrNull(1) as? io.socket.client.Ack
            scope.launch {
                val result = runCatching { answer(json.decodeFromString(InferenceRequest.serializer(), payload)) }
                val body = result.fold(
                    onSuccess = { JSONObject().put("ok", true).put("result", JSONObject(CraveJson.encodeToString(InferenceResult.serializer(), it))) },
                    onFailure = { error ->
                        val code = (error as? InferenceException)?.code ?: "INFERENCE_FAILED"
                        JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", error.message ?: code))
                    },
                )
                acknowledge?.call(body)
            }
        }
        client.connect()
    }

    fun heartbeat() { socket?.emit("inference:heartbeat", JSONObject().put("version", 1).put("timestamp", System.currentTimeMillis())) }

    fun disconnect() {
        socket?.disconnect()
        socket = null
    }

    suspend fun answer(request: InferenceRequest, hostedFallback: HostedFallback = HostedFallback.ASK, nanoLimit: Int = 4000): InferenceResult {
        val provider = when (request.provider) {
            "aicore" -> OrchestrationProvider.AICORE
            "litert" -> OrchestrationProvider.LITERT
            "google" -> OrchestrationProvider.GOOGLE
            else -> OrchestrationProvider.AUTO
        }
        val decision = routeAgent(AgentRouteInput(
            provider = provider,
            hostedFallback = hostedFallback,
            appOnTop = appOnTop(),
            aicoreAvailable = aicore.checkReady(),
            litertReady = litert.ready,
            estTokens = request.messages.sumOf { it.content.length / 4 },
            nanoLimit = nanoLimit,
        ))
        return when (decision.runtime) {
            AgentRuntime.AICORE -> aicore.run(request)
            AgentRuntime.LITERT -> litert.run(request)
            AgentRuntime.FIREBASE_CLOUD -> cloud.run(request)
            AgentRuntime.CANCELLED -> throw InferenceException("INFERENCE_CANCELLED", "Browser inference was cancelled")
            AgentRuntime.ERROR -> throw InferenceException(decision.code ?: "INFERENCE_FAILED", decision.code ?: "Local inference failed")
        }
    }
}
