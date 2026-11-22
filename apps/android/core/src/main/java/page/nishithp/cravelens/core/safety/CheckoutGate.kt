package page.nishithp.cravelens.core.safety

import page.nishithp.cravelens.core.model.CartSuggestion

const val CART_LIMIT_INR = 1000.0

fun orderBlocked(suggestion: CartSuggestion?): Boolean {
    if (suggestion == null) return true
    if (suggestion.cartLimitExceeded == true) return true
    val amount = suggestion.finalAmount ?: return true
    return amount >= CART_LIMIT_INR
}

enum class DecisionOutcome { ORDERED, PAYMENT_PENDING, PAYMENT_DECLINED, PAYMENT_REVIEW_REQUIRED, UNCERTAIN, REJECTED }

class CheckoutClient(private val send: (String) -> String) {
    private val sent = mutableSetOf<String>()

    fun approve(threadId: String, paymentMethod: String): DecisionOutcome {
        if (!sent.add(threadId)) return DecisionOutcome.UNCERTAIN
        return try {
            when (send(paymentMethod)) {
                "ordered" -> DecisionOutcome.ORDERED
                "payment_pending" -> DecisionOutcome.PAYMENT_PENDING
                "payment_declined" -> DecisionOutcome.PAYMENT_DECLINED
                "payment_review_required" -> DecisionOutcome.PAYMENT_REVIEW_REQUIRED
                else -> DecisionOutcome.UNCERTAIN
            }
        } catch (_: Exception) {
            DecisionOutcome.UNCERTAIN
        }
    }
}
