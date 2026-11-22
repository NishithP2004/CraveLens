package page.nishithp.cravelens.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class FoodDish(
    val dish: String,
    val description: String = "",
    val cuisine: String = "unknown",
    val ingredients: List<String> = emptyList(),
    val confidence: Double,
)

@Serializable
enum class FoodContext {
    @SerialName("ready_to_eat") READY_TO_EAT,
    @SerialName("recipe") RECIPE,
    @SerialName("restaurant_experience") RESTAURANT_EXPERIENCE,
}

@Serializable
data class FoodVerification(
    val isFood: Boolean,
    val dish: String,
    val description: String = "",
    val cuisine: String,
    val ingredients: List<String> = emptyList(),
    val confidence: Double,
    val context: FoodContext,
    val dishes: List<FoodDish> = emptyList(),
)

@Serializable
data class OrchestrateRequest(
    val videoId: String,
    val timestamp: Double,
    val triggerConfidence: Double,
    val verification: FoodVerification,
    val videoTitle: String = "Android screen",
    val location: String = "Bengaluru",
    val addressId: String? = null,
    val streamId: String? = null,
    val personalContext: String = "",
    val timeZone: String? = null,
    val sourceKind: String? = null,
)

@Serializable
data class CartCustomization(
    val instruction: String,
    val streamId: String? = null,
    val personalContext: String? = null,
    val timeZone: String? = null,
)

@Serializable
data class Selection(
    val kind: String,
    val format: String,
    val groupId: String,
    val choiceId: String,
)

@Serializable
sealed interface CartMutation {
    @Serializable
    @SerialName("set_quantity")
    data class SetQuantity(
        val itemId: String,
        val quantity: Int,
        val confirmSameCustomizations: Boolean = false,
    ) : CartMutation

    @Serializable
    @SerialName("add_item")
    data class AddItem(
        val itemId: String,
        val itemName: String? = null,
        val selections: List<Selection>? = null,
    ) : CartMutation
}

@Serializable
data class CouponSelection(val couponCode: String)

@Serializable
data class PreferenceRequest(val personalContext: String = "", val addressId: String)

@Serializable
data class SavedAddress(
    val id: String = "",
    val addressString: String = "",
    val receiverName: String = "",
)

@Serializable
data class PreferenceHistory(
    val matched: Int = 0,
    val target: Int = 7,
    val checked: Int = 0,
    val excluded: Int = 0,
    val incomplete: Boolean = false,
    val scope: String? = null,
)

@Serializable
data class PreferenceDraft(
    val preferences: String = "",
    val notes: String = "",
    val history: PreferenceHistory = PreferenceHistory(),
)

@Serializable
data class PreferenceProgress(val message: String = "", val at: Long = 0)

@Serializable
data class HostedFallback(val status: String = "", val delivery: String? = null)

@Serializable
data class PreferenceJob(
    val runId: String = "",
    val original: String = "",
    val addressId: String = "",
    val status: String = "",
    val error: String? = null,
    val progress: List<PreferenceProgress> = emptyList(),
    val result: PreferenceDraft? = null,
    val fallback: HostedFallback? = null,
    val createdAt: Long = 0,
)

@Serializable
data class FollowUpOption(val value: String, val label: String, val description: String? = null)

@Serializable
data class FollowUpField(
    val id: String,
    val type: String,
    val label: String,
    val required: Boolean = true,
    val placeholder: String? = null,
    val defaultValue: JsonElement? = null,
    val options: List<FollowUpOption>? = null,
)

@Serializable
data class AgentFollowUp(
    val version: Int = 1,
    val title: String,
    val description: String? = null,
    val fields: List<FollowUpField>,
    val submitLabel: String = "Continue",
)

@Serializable
data class VlmSettings(val provider: String = "auto", val model: String? = null)

@Serializable
data class OrchestrationSettings(
    val provider: String = "auto",
    val model: String? = null,
    val baseUrl: String? = null,
    val contextTokens: Int = 16_384,
    val thinkingEnabled: Boolean = false,
)

@Serializable
data class OllamaSettings(val baseUrl: String = "http://localhost:11434")

@Serializable
data class ModelSettings(
    val version: Int = 1,
    val vlm: VlmSettings = VlmSettings(),
    val orchestration: OrchestrationSettings = OrchestrationSettings(),
    val ollama: OllamaSettings = OllamaSettings(),
    val hostedFallback: String = "ask",
)

@Serializable
data class DeviceSession(
    val deviceId: String,
    val accessToken: String,
    val accessExpiresAt: Long,
    val refreshToken: String,
    val refreshExpiresAt: Long,
)

@Serializable
data class PublicPayment(
    val amount: Double,
    val upiString: String,
    val bridgeUrl: String? = null,
    val expiresAt: String,
)

@Serializable
data class InferenceMessage(
    val role: String,
    val content: String = "",
    val name: String? = null,
    val toolCallId: String? = null,
    val toolCalls: List<InferenceToolCall>? = null,
)

@Serializable
data class InferenceToolCall(val id: String, val name: String, val args: JsonObject = JsonObject(emptyMap()))

@Serializable
data class InferenceOptions(
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val contextTokens: Int? = null,
    val thinkingEnabled: Boolean = false,
    val toolChoice: JsonElement? = null,
)

@Serializable
data class InferenceRequest(
    val version: Int = 1,
    val requestId: String,
    val provider: String,
    val model: String,
    val messages: List<InferenceMessage>,
    val tools: List<JsonObject> = emptyList(),
    val options: InferenceOptions = InferenceOptions(),
    val stream: Boolean = false,
    val deadline: Long,
)

@Serializable
data class InferenceResult(
    val version: Int = 1,
    val requestId: String,
    val content: String,
    val toolCalls: List<InferenceToolCall> = emptyList(),
    val finishReason: String,
    val usage: JsonObject? = null,
    val metrics: JsonObject? = null,
)

@Serializable
data class CartSuggestion(
    val threadId: String? = null,
    val conversationId: String? = null,
    val dish: String? = null,
    val detectedFood: String? = null,
    val restaurantId: String? = null,
    val restaurant: String? = null,
    val restaurantLogoUrl: String? = null,
    val restaurantRating: Double? = null,
    val restaurantRatingCount: Int? = null,
    val restaurantLocation: String? = null,
    val item: String? = null,
    val imageUrl: String? = null,
    val price: Double? = null,
    val savings: Double? = null,
    val finalAmount: Double? = null,
    val cartLimitExceeded: Boolean? = null,
    val receipt: JsonObject? = null,
    val deliveryEta: String? = null,
    val coupon: String? = null,
    val availablePromos: List<JsonObject>? = null,
    val rationale: String? = null,
    val explanationSource: String? = null,
    val dietaryNotes: List<String>? = null,
    val personalContext: String? = null,
    val agentFollowUp: AgentFollowUp? = null,
    val paymentOptions: JsonObject? = null,
    val availablePaymentMethods: List<String>? = null,
    val addressId: String? = null,
    val deliveryAddress: String? = null,
    val expiresAt: String? = null,
    val status: String? = null,
)

enum class ThreadStatus {
    AWAITING_CONFIRMATION, UPDATING_CART, UPDATING_COUPON, CUSTOMIZING, PLACING_ORDER,
    PAYMENT_PENDING, PAYMENT_PAID, CONFIRMING_PAYMENT, PAYMENT_CANCELLING, PAYMENT_CANCELLED,
    PAYMENT_FAILED, PAYMENT_REVIEW_REQUIRED, CONFIRMATION_FAILED, PLACEMENT_FAILED, ORDERED,
    REJECTED, PAYMENT_DECLINED, UNKNOWN;

    companion object {
        fun from(value: String?) = entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: UNKNOWN
    }
}
