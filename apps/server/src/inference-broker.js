import crypto from "node:crypto";
import { InferenceRequestSchema, InferenceResultSchema } from "@cravelens/shared";
import { recordEvent } from "./analytics.js";
import { config } from "./config.js";

const DEVICE_ID = /^[a-f0-9-]{36}$/i;

class InferenceBroker {
  constructor() { this.namespace = undefined; this.pendingByDevice = new Map(); this.capabilities = new Map(); this.chunkHandlers = new Map(); }

  attach(namespace) {
    this.namespace = namespace;
    namespace.on("connection", (socket) => {
      const deviceId = socket.data.deviceId;
      socket.join(deviceRoom(deviceId));
      socket.on("inference:register", (payload, acknowledge) => {
        const providers = (Array.isArray(payload?.providers) ? payload.providers : []).slice(0, 32).map(normalizeProvider).filter((item) => item.provider);
        this.capabilities.set(deviceId, { providers, updatedAt: Date.now(), socketId: socket.id });
        acknowledge?.({ ok: true });
      });
      socket.on("inference:heartbeat", () => {
        const current = this.capabilities.get(deviceId);
        if (current) current.updatedAt = Date.now();
      });
      socket.on("inference:chunk", (payload) => {
        if (!payload?.requestId || typeof payload.content !== "string" || payload.content.length > 100_000) return;
        this.chunkHandlers.get(`${deviceId}:${payload.requestId}`)?.(payload.content);
      });
      socket.on("disconnect", () => {
        if (this.capabilities.get(deviceId)?.socketId === socket.id) this.capabilities.delete(deviceId);
      });
    });
  }

  getCapabilities(deviceId) { return this.capabilities.get(deviceId)?.providers || []; }

  getRegisteredContextTokens(deviceId, provider) {
    const match = this.getCapabilities(deviceId).find((item) => item?.provider === provider && item.ready !== false && Number.isFinite(item.contextTokens));
    return match ? Number(match.contextTokens) : undefined;
  }

  async invoke(deviceId, input, { signal, timeoutMs = config.localInferenceTimeoutMs, onChunk } = {}) {
    if (!this.namespace || !DEVICE_ID.test(deviceId)) throw inferenceError("Browser inference is unavailable", "INFERENCE_UNAVAILABLE");
    const pending = this.pendingByDevice.get(deviceId) || 0;
    if (pending >= config.localInferenceQueueLimit) throw inferenceError("Browser inference queue is full", "INFERENCE_OVERLOADED", 429);
    const request = InferenceRequestSchema.parse({ version: 1, requestId: crypto.randomUUID(), deadline: Date.now() + timeoutMs, ...input });
    this.pendingByDevice.set(deviceId, pending + 1);
    const chunkKey = `${deviceId}:${request.requestId}`;
    if (onChunk) this.chunkHandlers.set(chunkKey, onChunk);
    const abort = () => this.namespace.to(deviceRoom(deviceId)).emit("inference:cancel", { version: 1, requestId: request.requestId });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw inferenceError("Browser inference was cancelled", "INFERENCE_CANCELLED", 499);
      const responses = await this.namespace.to(deviceRoom(deviceId)).timeout(timeoutMs).emitWithAck("inference:invoke", request);
      const response = responses?.find((item) => item?.ok || item?.error);
      if (!response) throw inferenceError("No connected browser accepted the inference request", "INFERENCE_OFFLINE", 503);
      if (!response.ok) throw inferenceError(response.error?.message || "Browser inference failed", response.error?.code || "INFERENCE_FAILED", 502);
      const result = InferenceResultSchema.parse(response.result);
      const runtime = result.metrics?.runtime;
      if (runtime) void recordEvent({ id: `inference:${result.requestId}`, kind: "inference_runtime", runtime: String(runtime), provider: request.provider, model: String(result.metrics?.model || request.model || "") });
      return result;
    } catch (error) {
      if (/operation has timed out/i.test(error?.message || "")) {
        abort();
        throw inferenceError("Browser inference timed out", "INFERENCE_TIMEOUT", 504);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.chunkHandlers.delete(chunkKey);
      const remaining = (this.pendingByDevice.get(deviceId) || 1) - 1;
      if (remaining > 0) this.pendingByDevice.set(deviceId, remaining); else this.pendingByDevice.delete(deviceId);
    }
  }
}

function normalizeProvider(provider) {
  const contextTokens = Number(provider?.contextTokens);
  return {
    provider: String(provider?.provider || "").trim(),
    ...(provider?.model ? { model: String(provider.model).slice(0, 200) } : {}),
    ...(Array.isArray(provider?.capabilities) ? { capabilities: provider.capabilities.map((item) => String(item)).slice(0, 8) } : {}),
    ready: provider?.ready !== false,
    ...(Number.isFinite(contextTokens) && contextTokens > 0 && contextTokens <= 200_000 ? { contextTokens } : {}),
    ...(provider?.runtime ? { runtime: String(provider.runtime).slice(0, 40) } : {}),
  };
}

export const inferenceBroker = new InferenceBroker();
export function deviceRoom(deviceId) { return `inference:device:${deviceId}`; }
function inferenceError(message, code, statusCode = 503) { return Object.assign(new Error(message), { code, statusCode }); }
