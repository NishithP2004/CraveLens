package page.nishithp.cravelens.core

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import page.nishithp.cravelens.core.agent.editDistance
import page.nishithp.cravelens.core.agent.liteRtToolPolicy
import page.nishithp.cravelens.core.agent.mapToolSchema
import page.nishithp.cravelens.core.agent.repairToolName
import page.nishithp.cravelens.core.agent.trimOldestExchange
import page.nishithp.cravelens.core.api.TokenRefresher
import page.nishithp.cravelens.core.api.noRetryClient
import page.nishithp.cravelens.core.events.agentEventMessage
import page.nishithp.cravelens.core.identity.foodCravingIdentity
import page.nishithp.cravelens.core.json.CraveJson
import page.nishithp.cravelens.core.model.CartCustomization
import page.nishithp.cravelens.core.model.CartMutation
import page.nishithp.cravelens.core.model.DeviceSession
import page.nishithp.cravelens.core.model.FoodContext
import page.nishithp.cravelens.core.model.FoodVerification
import page.nishithp.cravelens.core.model.InferenceMessage
import page.nishithp.cravelens.core.model.InferenceOptions
import page.nishithp.cravelens.core.model.InferenceRequest
import page.nishithp.cravelens.core.model.OrchestrateRequest
import page.nishithp.cravelens.core.parse.VerificationParseException
import page.nishithp.cravelens.core.parse.parseVerification
import page.nishithp.cravelens.core.routing.AgentRouteInput
import page.nishithp.cravelens.core.routing.AgentRuntime
import page.nishithp.cravelens.core.routing.HostedFallback
import page.nishithp.cravelens.core.routing.NanoStatus
import page.nishithp.cravelens.core.routing.OrchestrationProvider
import page.nishithp.cravelens.core.routing.VisionAction
import page.nishithp.cravelens.core.routing.VisionInput
import page.nishithp.cravelens.core.routing.VisionTrigger
import page.nishithp.cravelens.core.routing.routeAgent
import page.nishithp.cravelens.core.routing.lassoVision
import page.nishithp.cravelens.core.routing.routeVision
import page.nishithp.cravelens.core.safety.CART_LIMIT_INR
import page.nishithp.cravelens.core.safety.CheckoutClient
import page.nishithp.cravelens.core.safety.DecisionOutcome
import page.nishithp.cravelens.core.safety.orderBlocked
import page.nishithp.cravelens.core.sampler.AdaptiveSampler
import page.nishithp.cravelens.core.sampler.CartBuildLock
import page.nishithp.cravelens.core.sampler.NudgeRateLimiter
import page.nishithp.cravelens.core.sampler.ThermalLevel
import page.nishithp.cravelens.core.yolo.decodeOutput
import page.nishithp.cravelens.core.yolo.letterboxTransform
import page.nishithp.cravelens.core.model.CartSuggestion
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

class CoreLogicTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test fun yoloDecodesChannelFirstAndAppliesNms() {
        val count = 8
        val data = FloatArray(5 * count)
        fun put(channel: Int, index: Int, value: Float) { data[channel * count + index] = value }
        put(0, 0, 10f); put(1, 0, 10f); put(2, 0, 4f); put(3, 0, 4f); put(4, 0, 0.9f)
        put(0, 1, 10.2f); put(1, 1, 10.2f); put(2, 1, 4f); put(3, 1, 4f); put(4, 1, 0.8f)
        put(0, 2, 40f); put(1, 2, 40f); put(2, 2, 6f); put(3, 2, 6f); put(4, 2, 0.2f)
        val kept = decodeOutput(data, intArrayOf(1, 5, count), 0.38f)
        assertEquals(1, kept.size)
        assertEquals(0.9f, kept[0].score)
        assertEquals("food", kept[0].label)
    }

    @Test fun yoloDecodesChannelLastAndCapsAt25() {
        val count = 30
        val data = FloatArray(count * 5)
        for (index in 0 until count) {
            data[index * 5] = index * 20f
            data[index * 5 + 1] = 0f
            data[index * 5 + 2] = 2f
            data[index * 5 + 3] = 2f
            data[index * 5 + 4] = 0.5f + index / 100f
        }
        val kept = decodeOutput(data, intArrayOf(1, count, 5), 0.38f)
        assertEquals(25, kept.size)
        assertTrue(kept.first().score >= kept.last().score)
    }

    @Test fun letterboxCentersTheFrame() {
        val box = letterboxTransform(1280, 720)
        assertEquals(640, (box.x * 2 + kotlin.math.round(1280 * box.scale)).toInt())
        assertTrue(box.y >= 0)
    }

    @Test fun parserClampsAndRejectsBadContext() {
        val parsed = parseVerification("sure {\"isFood\":true,\"dish\":\"Dosa\",\"cuisine\":\"Indian\",\"ingredients\":[\"rice\"],\"confidence\":1.4,\"context\":\"ready_to_eat\",\"dishes\":[]}")
        assertEquals(1.0, parsed.confidence, 0.0)
        assertEquals(FoodContext.READY_TO_EAT, parsed.context)
        assertThrows(VerificationParseException::class.java) {
            parseVerification("{\"isFood\":true,\"dish\":\"Dosa\",\"context\":\"snack\"}")
        }
        val dishes = (1..9).joinToString(",") { """{"dish":"D$it","description":"x","cuisine":"u","ingredients":[],"confidence":0.5}""" }
        assertThrows(VerificationParseException::class.java) {
            parseVerification("""{"isFood":true,"dish":"D","cuisine":"u","ingredients":[],"confidence":0.9,"context":"recipe","dishes":[$dishes]}""")
        }
    }

    @Test fun visionRouterKeepsPixelsOnDeviceUnlessConsentIsAuto() {
        val base = VisionInput(VisionTrigger.WATCH, appOnTop = false, consent = HostedFallback.ASK, nano = NanoStatus.AVAILABLE)
        assertFalse(routeVision(base).allowCloud)
        assertEquals(VisionAction.HOLD_FOR_TAP, routeVision(base).reason.let { routeVision(base).action })
        assertEquals("R3", routeVision(base.copy(consent = HostedFallback.AUTO)).reason)
        assertTrue(routeVision(base.copy(consent = HostedFallback.AUTO)).allowCloud)
        assertFalse(routeVision(base.copy(consent = HostedFallback.AUTO)).preferOnDevice)
        val lasso = routeVision(base.copy(trigger = VisionTrigger.LASSO, appOnTop = true, consent = HostedFallback.NONE))
        assertEquals(VisionAction.NANO_ONLY, lasso.action)
        assertFalse(lasso.allowCloud)
        assertFalse(lasso.preferOnDevice)
        val hybrid = routeVision(base.copy(trigger = VisionTrigger.LASSO, appOnTop = true, consent = HostedFallback.AUTO))
        assertEquals(VisionAction.HYBRID, hybrid.action)
        assertTrue(hybrid.preferOnDevice)
        assertEquals(VisionAction.CLOUD_ONLY, routeVision(base.copy(nano = NanoStatus.UNAVAILABLE, consent = HostedFallback.AUTO)).action)
        assertEquals(VisionAction.YOLO_ONLY, routeVision(base.copy(nano = NanoStatus.DOWNLOADING, consent = HostedFallback.NONE)).action)
        assertEquals(VisionAction.DROP, routeVision(base.copy(isFood = false, consent = HostedFallback.AUTO)).action)
        assertEquals(VisionAction.ASK_CLOUD, routeVision(base.copy(lowConfidence = true)).action)
        assertFalse(routeVision(base.copy(lowConfidence = true)).allowCloud)
        assertTrue(routeVision(base.copy(lowConfidence = true, consent = HostedFallback.AUTO)).allowCloud)
        assertEquals(VisionAction.DROP, routeVision(base.copy(parseFailed = true, consent = HostedFallback.NONE)).action)
        assertEquals(VisionAction.CLOUD_ONLY, lassoVision(HostedFallback.AUTO, NanoStatus.UNAVAILABLE, appOnTop = true).action)
        assertEquals(VisionAction.HOLD_FOR_TAP, lassoVision(HostedFallback.ASK, NanoStatus.UNAVAILABLE, appOnTop = true).action)
        assertEquals(VisionAction.NANO_ONLY, lassoVision(HostedFallback.ASK, NanoStatus.AVAILABLE, appOnTop = true).action)
    }

    @Test fun agentRouterNeverExecutesToolsAndHonorsFallback() {
        val ready = AgentRouteInput(OrchestrationProvider.AUTO, HostedFallback.ASK, appOnTop = true, aicoreAvailable = true, litertReady = true, estTokens = 1000, nanoLimit = 4000)
        val foreground = routeAgent(ready)
        assertEquals(AgentRuntime.AICORE, foreground.runtime)
        assertFalse(foreground.executesTool)
        val background = routeAgent(ready.copy(appOnTop = false, backgroundBlocked = true))
        assertEquals(AgentRuntime.LITERT, background.runtime)
        val unavailable = routeAgent(ready.copy(appOnTop = false, backgroundBlocked = true, litertReady = false))
        assertEquals(AgentRuntime.ERROR, unavailable.runtime)
        assertEquals("INFERENCE_UNAVAILABLE", unavailable.code)
        val autoCloud = routeAgent(ready.copy(appOnTop = false, litertReady = false, hostedFallback = HostedFallback.AUTO))
        assertEquals(AgentRuntime.FIREBASE_CLOUD, autoCloud.runtime)
        val overflow = routeAgent(ready.copy(estTokens = 9000, litertReady = false))
        assertEquals("INFERENCE_CONTEXT_OVERFLOW", overflow.code)
        assertEquals(AgentRuntime.LITERT, routeAgent(ready.copy(estTokens = 9000, litertReady = true)).runtime)
        val cancelled = routeAgent(ready.copy(cancelled = true, hostedFallback = HostedFallback.AUTO))
        assertEquals(AgentRuntime.CANCELLED, cancelled.runtime)
        assertEquals(AgentRuntime.ERROR, routeAgent(ready.copy(disallowedToolCall = true, hostedFallback = HostedFallback.AUTO)).runtime)
        assertEquals(AgentRuntime.LITERT, routeAgent(ready.copy(provider = OrchestrationProvider.LITERT, appOnTop = false)).runtime)
    }

    @Test fun nearMissRepairsOnlyASingleCandidate() {
        assertEquals("update_food_cart", repairToolName("update_food_carts", setOf("update_food_cart", "get_food_cart")))
        assertNull(repairToolName("upd", setOf("update_food_cart", "get_food_cart")))
        assertEquals(1, editDistance("get_food_cart", "get_food_car"))
    }

    @Test fun toolPolicyMatchesTheExtensionWording() {
        val tool = buildJsonObject { put("name", "get_food_cart") }
        val request = InferenceRequest(
            requestId = "00000000-0000-0000-0000-000000000001",
            provider = "aicore",
            model = "gemini-nano-4-fast",
            messages = listOf(InferenceMessage("user", "Find food")),
            tools = listOf(tool),
            options = InferenceOptions(toolChoice = kotlinx.serialization.json.JsonPrimitive("required")),
            deadline = 1,
        )
        val policy = liteRtToolPolicy(request)
        assertTrue(policy.required)
        assertTrue(policy.instruction.startsWith("CURRENT TURN: Invoke an appropriate provided tool"))
        assertThrows(page.nishithp.cravelens.core.agent.InferenceException::class.java) {
            mapToolSchema(buildJsonObject { put("name", "bad"); put("parameters", buildJsonObject { put("anyOf", kotlinx.serialization.json.JsonArray(emptyList())) }) })
        }
    }

    @Test fun trimmerDropsTheOldestExchange() {
        val messages = listOf(
            InferenceMessage("system", "rules"),
            InferenceMessage("user", "first"),
            InferenceMessage("assistant", "old", toolCalls = emptyList()),
            InferenceMessage("tool", "old result", name = "search_restaurants"),
            InferenceMessage("user", "latest"),
        )
        val trimmed = trimOldestExchange(messages)
        assertNotNull(trimmed)
        assertEquals("system", trimmed!!.first().role)
        assertTrue(trimmed.any { it.role == "user" && it.content == "first" })
        assertEquals("latest", trimmed.last().content)
        assertFalse(trimmed.any { it.content == "old" })
    }

    @Test fun identityMatchesTheSharedGoldenFile() {
        val fixtures = json.parseToJsonElement(File("../tests/fixtures/identity-golden.json").readText()).jsonArray
        fixtures.forEach { element ->
            val input = element.jsonObject["input"]!!.jsonObject
            val expected = CraveJson.encodeToString(page.nishithp.cravelens.core.identity.CravingIdentity.serializer(), foodCravingIdentity(input.toMap()))
            val actual = CraveJson.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), element.jsonObject["identity"]!!)
            assertEquals(actual, expected)
        }
    }

    @Test fun promptsAndLabelsComeFromTheSharedExport() {
        val prompts = File("src/main/assets/shared/prompts.json").readText()
        assertTrue(prompts.contains("NEVER place an order"))
        assertTrue(prompts.contains("Return at most 3 dishes"))
        assertTrue(prompts.contains("CURRENT TURN:"))
        val labels = json.parseToJsonElement(File("src/main/assets/shared/labels.json").readText()).jsonObject
        val fixtures = json.parseToJsonElement(File("../tests/fixtures/agent-events.json").readText()).jsonArray
        fixtures.forEach { fixture ->
            val event = fixture.jsonObject["event"]!!.jsonPrimitive.content
            val details = fixture.jsonObject["details"]!!.jsonObject
            val expected = fixture.jsonObject["message"]?.jsonPrimitive?.contentOrNull()
            assertEquals(expected, agentEventMessage(labels, event, details))
        }
    }

    @Test fun samplerNeverGoesFasterThanTheSetting() {
        val sampler = AdaptiveSampler()
        val delay = sampler.nextDelayMs(0.3f, 0.38f, 1000, ThermalLevel.NONE, batterySaver = false, screenOff = false, now = 1_000)
        assertEquals(1000L, delay)
        assertNull(sampler.nextDelayMs(null, 0.38f, 1000, ThermalLevel.SEVERE, false, false, now = 2_000))
        assertEquals(2000L, sampler.nextDelayMs(null, 0.38f, 1000, ThermalLevel.MODERATE, false, false, now = 3_000))
    }

    @Test fun nudgeLimiterEnforcesIntervalAndHourlyCap() {
        val limiter = NudgeRateLimiter(minIntervalMs = 10, maxPerHour = 2)
        assertTrue(limiter.allow(0))
        assertFalse(limiter.allow(5))
        assertTrue(limiter.allow(10))
        assertFalse(limiter.allow(100))
    }

    @Test fun cartLockIsPerSourceAndDish() {
        val lock = CartBuildLock()
        assertTrue(lock.tryAcquire("watch", "dosa"))
        assertFalse(lock.tryAcquire("watch", "dosa"))
        assertTrue(lock.tryAcquire("lasso", "dosa"))
    }

    @Test fun concurrentRefreshRunsOnce() = runBlocking {
        var session = DeviceSession("device", "access", 0, "refresh-1", Long.MAX_VALUE)
        val calls = AtomicInteger()
        val release = kotlinx.coroutines.CompletableDeferred<Unit>()
        val refresher = TokenRefresher(current = { session }, store = { session = it }) {
            calls.incrementAndGet()
            release.await()
            DeviceSession("device", "access-2", System.currentTimeMillis() + 900_000, "refresh-2", Long.MAX_VALUE)
        }
        val jobs = (1..8).map { async(kotlinx.coroutines.Dispatchers.Default) { refresher.refreshAfterUnauthorized() } }
        while (calls.get() == 0) kotlinx.coroutines.delay(5)
        kotlinx.coroutines.delay(30)
        release.complete(Unit)
        jobs.awaitAll()
        assertEquals(1, calls.get())
        assertEquals("refresh-2", session.refreshToken)
    }

    @Test fun decisionIsNotRetriedAndOverCapCartsStayClosed() {
        assertFalse(noRetryClient().retryOnConnectionFailure)
        var calls = 0
        val client = CheckoutClient {
            calls += 1
            throw java.io.IOException("offline")
        }
        assertEquals(DecisionOutcome.UNCERTAIN, client.approve("thread", "UPI"))
        assertEquals(DecisionOutcome.UNCERTAIN, client.approve("thread", "UPI"))
        assertEquals(1, calls)
        assertTrue(orderBlocked(CartSuggestion(finalAmount = CART_LIMIT_INR, cartLimitExceeded = false)))
        assertTrue(orderBlocked(CartSuggestion(finalAmount = 100.0, cartLimitExceeded = true)))
        assertFalse(orderBlocked(CartSuggestion(finalAmount = 999.0, cartLimitExceeded = false)))
    }

    @Test fun serializedContractsExposeTheSharedFieldNames() {
        val verification = FoodVerification(true, "Dosa", "Crisp", "South Indian", listOf("rice"), 0.9, FoodContext.READY_TO_EAT)
        val request = OrchestrateRequest("and-abc123", 1.0, 0.8, verification, sourceKind = "android-watch")
        val encoded = CraveJson.encodeToString(OrchestrateRequest.serializer(), request)
        assertTrue(encoded.contains("\"sourceKind\":\"android-watch\""))
        val mutation = CraveJson.encodeToString(CartMutation.serializer(), CartMutation.SetQuantity("item", 2))
        assertTrue(mutation.contains("\"action\":\"set_quantity\""))
        val custom = CraveJson.encodeToString(CartCustomization.serializer(), CartCustomization("less spicy"))
        assertTrue(custom.contains("less spicy"))
        val schema = File("src/main/assets/shared/shared-schemas.json").readText()
        assertTrue(schema.contains("aicore"))
        assertTrue(schema.contains("ready_to_eat"))
        assertTrue(schema.contains("android-watch"))
        assertTrue(schema.contains("\"auto\""))
    }
}

class SharedSchemaParityTest {
    @Test fun exportedSchemasMatchTheKotlinContract() {
        val schema = File("src/main/assets/shared/shared-schemas.json").readText()
        listOf("isFood", "ready_to_eat", "recipe", "restaurant_experience", "aicore", "litert", "ollama", "android-watch", "android-lasso", "\"ask\"", "\"auto\"", "\"none\"").forEach {
            assertTrue(schema.contains(it))
        }
        val prompts = File("src/main/assets/shared/prompts.json").readText()
        assertTrue(prompts.contains("NEVER place an order"))
        assertTrue(prompts.contains("Return at most 3 dishes"))
        val request = OrchestrateRequest("and-abc123", 1.0, 0.8, FoodVerification(true, "Dosa", "Crisp", "South Indian", listOf("rice"), 0.9, FoodContext.READY_TO_EAT), sourceKind = "android-lasso")
        assertTrue(CraveJson.encodeToString(OrchestrateRequest.serializer(), request).contains("android-lasso"))
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull() = if (isString) content else null

private fun JsonObject.toMap(): Map<String, Any?> = entries.associate { (key, value) ->
    key to when (value) {
        is kotlinx.serialization.json.JsonPrimitive -> value.content
        is kotlinx.serialization.json.JsonArray -> value.map { element ->
            when (element) {
                is JsonObject -> element.toMap()
                is kotlinx.serialization.json.JsonPrimitive -> element.content
                else -> element.toString()
            }
        }
        is JsonObject -> value.toMap()
        else -> null
    }
}
