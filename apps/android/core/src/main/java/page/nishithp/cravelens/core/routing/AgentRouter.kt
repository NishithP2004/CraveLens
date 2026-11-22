package page.nishithp.cravelens.core.routing

enum class OrchestrationProvider { AUTO, AICORE, LITERT, OPENAI_COMPATIBLE, GOOGLE }

enum class AgentRuntime { AICORE, LITERT, FIREBASE_CLOUD, ERROR, CANCELLED }

data class AgentRouteInput(
    val provider: OrchestrationProvider,
    val hostedFallback: HostedFallback,
    val appOnTop: Boolean,
    val aicoreAvailable: Boolean,
    val litertReady: Boolean,
    val estTokens: Int,
    val nanoLimit: Int,
    val backgroundBlocked: Boolean = false,
    val overflow: Boolean = false,
    val busyExhausted: Boolean = false,
    val invalidToolCalls: Int = 0,
    val decodingFailed: Boolean = false,
    val cancelled: Boolean = false,
    val disallowedToolCall: Boolean = false,
)

data class AgentDecision(val runtime: AgentRuntime, val code: String? = null) {
    val executesTool: Boolean = false
}

fun routeAgent(input: AgentRouteInput): AgentDecision {
    if (input.cancelled) return AgentDecision(AgentRuntime.CANCELLED, "INFERENCE_CANCELLED")
    if (input.disallowedToolCall) return AgentDecision(AgentRuntime.ERROR, "INFERENCE_INVALID_TOOL_CALL")
    if (input.provider == OrchestrationProvider.LITERT) {
        return if (input.litertReady && !input.overflow && !input.decodingFailed) AgentDecision(AgentRuntime.LITERT)
        else localFailure(input, if (input.overflow) "INFERENCE_CONTEXT_OVERFLOW" else "INFERENCE_UNAVAILABLE")
    }
    val nanoFits = input.estTokens <= input.nanoLimit && !input.overflow
    val nanoOk = input.provider != OrchestrationProvider.GOOGLE && input.provider != OrchestrationProvider.OPENAI_COMPATIBLE &&
        input.appOnTop && !input.backgroundBlocked && input.aicoreAvailable && nanoFits &&
        !input.busyExhausted && input.invalidToolCalls < 2 && !input.decodingFailed
    if (nanoOk && (input.provider == OrchestrationProvider.AUTO || input.provider == OrchestrationProvider.AICORE)) {
        return AgentDecision(AgentRuntime.AICORE)
    }
    val blocked = !input.appOnTop || input.backgroundBlocked
    val overflow = !nanoFits
    val nanoFailed = input.busyExhausted || input.invalidToolCalls >= 2 || input.decodingFailed || !input.aicoreAvailable
    if (input.provider == OrchestrationProvider.AICORE || input.provider == OrchestrationProvider.AUTO) {
        if ((blocked || overflow || nanoFailed) && input.litertReady && !input.overflow) return AgentDecision(AgentRuntime.LITERT)
        if (overflow && input.litertReady) return AgentDecision(AgentRuntime.LITERT)
        val code = when {
            overflow -> "INFERENCE_CONTEXT_OVERFLOW"
            input.busyExhausted -> "INFERENCE_OVERLOADED"
            input.decodingFailed -> "INFERENCE_DECODING_FAILED"
            else -> "INFERENCE_UNAVAILABLE"
        }
        return localFailure(input, code)
    }
    return localFailure(input, "INFERENCE_UNAVAILABLE")
}

private fun localFailure(input: AgentRouteInput, code: String): AgentDecision {
    if (input.cancelled) return AgentDecision(AgentRuntime.CANCELLED, "INFERENCE_CANCELLED")
    return if (input.hostedFallback == HostedFallback.AUTO) AgentDecision(AgentRuntime.FIREBASE_CLOUD, code)
    else AgentDecision(AgentRuntime.ERROR, code)
}
