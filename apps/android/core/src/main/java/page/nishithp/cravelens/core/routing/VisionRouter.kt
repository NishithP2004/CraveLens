package page.nishithp.cravelens.core.routing

enum class HostedFallback { AUTO, ASK, NONE }

enum class VisionTrigger { WATCH, LASSO }

enum class NanoStatus { AVAILABLE, UNAVAILABLE, DOWNLOADING, DOWNLOADABLE }

enum class VisionAction { HYBRID, NANO_ONLY, CLOUD_ONLY, HOLD_FOR_TAP, DROP, YOLO_ONLY, ASK_CLOUD }

fun hostedFallbackOf(value: String): HostedFallback = when (value.trim().lowercase()) {
    "auto" -> HostedFallback.AUTO
    "none" -> HostedFallback.NONE
    else -> HostedFallback.ASK
}

fun nanoStatusOf(value: String): NanoStatus = when (value.trim().uppercase()) {
    "AVAILABLE" -> NanoStatus.AVAILABLE
    "DOWNLOADING" -> NanoStatus.DOWNLOADING
    "DOWNLOADABLE" -> NanoStatus.DOWNLOADABLE
    else -> NanoStatus.UNAVAILABLE
}

fun lassoVision(consent: HostedFallback, nano: NanoStatus, appOnTop: Boolean): VisionDecision = routeVision(
    VisionInput(trigger = VisionTrigger.LASSO, appOnTop = appOnTop, consent = consent, nano = nano),
)

data class VisionInput(
    val trigger: VisionTrigger,
    val appOnTop: Boolean,
    val consent: HostedFallback,
    val nano: NanoStatus,
    val onDeviceDisabled: Boolean = false,
    val backgroundBlocked: Boolean = false,
    val busyExhausted: Boolean = false,
    val parseFailed: Boolean = false,
    val lowConfidence: Boolean = false,
    val isFood: Boolean? = null,
    val userApprovedCloud: Boolean = false,
)

data class VisionDecision(
    val action: VisionAction,
    val allowCloud: Boolean,
    val preferOnDevice: Boolean,
    val reason: String,
)

fun routeVision(input: VisionInput): VisionDecision {
    if (input.isFood == false) return decision(VisionAction.DROP, false, "R11")
    if (input.lowConfidence || input.parseFailed || input.busyExhausted) return lowConfidence(input)
    val nanoReady = input.nano == NanoStatus.AVAILABLE && !input.onDeviceDisabled
    if (!nanoReady) {
        return when (input.consent) {
            HostedFallback.AUTO -> decision(VisionAction.CLOUD_ONLY, true, "R10")
            HostedFallback.ASK -> if (input.userApprovedCloud) decision(VisionAction.CLOUD_ONLY, true, "R10-approved") else decision(VisionAction.HOLD_FOR_TAP, false, "R10")
            HostedFallback.NONE -> decision(VisionAction.YOLO_ONLY, false, "R10")
        }
    }
    val foreground = input.appOnTop && !input.backgroundBlocked
    if (input.trigger == VisionTrigger.LASSO || foreground) {
        return if (input.consent == HostedFallback.AUTO) decision(VisionAction.HYBRID, true, if (input.trigger == VisionTrigger.LASSO) "R1" else "R1-foreground")
        else decision(VisionAction.NANO_ONLY, false, if (input.trigger == VisionTrigger.LASSO) "R2" else "R5-foreground")
    }
    return when (input.consent) {
        HostedFallback.AUTO -> decision(VisionAction.CLOUD_ONLY, true, "R3")
        HostedFallback.ASK -> decision(VisionAction.HOLD_FOR_TAP, false, "R4")
        HostedFallback.NONE -> decision(VisionAction.HOLD_FOR_TAP, false, "R5")
    }
}

private fun lowConfidence(input: VisionInput): VisionDecision = when (input.consent) {
    HostedFallback.AUTO -> decision(VisionAction.CLOUD_ONLY, true, "R6")
    HostedFallback.ASK -> if (input.userApprovedCloud) decision(VisionAction.CLOUD_ONLY, true, "R6-approved") else decision(VisionAction.ASK_CLOUD, false, "R6")
    HostedFallback.NONE -> decision(VisionAction.DROP, false, "R6")
}

private fun decision(action: VisionAction, allowCloud: Boolean, reason: String) = VisionDecision(
    action = action,
    allowCloud = allowCloud,
    preferOnDevice = action == VisionAction.HYBRID,
    reason = reason,
)
