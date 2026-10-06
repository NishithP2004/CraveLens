import "./config.js";
import { safeTraceMetadata, setTracingActive, traceContext } from "./trace-context.js";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

const hasPublicKey = Boolean(process.env.LANGFUSE_PUBLIC_KEY);
const hasSecretKey = Boolean(process.env.LANGFUSE_SECRET_KEY);
const enabled = process.env.NODE_ENV !== "test" && hasPublicKey && hasSecretKey;
let sdk;

export function initializeLangfuse({ spanProcessor } = {}) {
  if (!enabled) {
    if (hasPublicKey !== hasSecretKey) {
      console.warn("[langfuse] disabled: both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required");
    }
    return { enabled: false };
  }
  if (!sdk) {
    try {
      sdk = new NodeSDK({
        autoDetectResources: false,
        serviceName: "cravelens-server",
        spanProcessors: [
          new PrivacySpanProcessor(spanProcessor || new LangfuseSpanProcessor({
            mask: ({ data }) => maskTraceData(data),
            mediaUploadEnabled: false,
          })),
        ],
      });
      sdk.start();
    } catch (error) {
      sdk = undefined;
      console.warn("[langfuse] initialization failed; tracing remains disabled", error instanceof Error ? error.message : error);
      return { enabled: false };
    }
  }
  setTracingActive(true);
  return { enabled: true };
}

export function createLangfuseHandler({ sessionId, traceMetadata } = {}) {
  if (!enabled || !sdk) return undefined;
  try {
    return new WorkflowCallbackHandler({
      sessionId: traceContext().sessionId || sessionId,
      tags: ["cravelens", "swiggy-food-agent"],
      version: process.env.npm_package_version,
      traceMetadata: safeTraceMetadata({ ...traceContext(), ...traceMetadata }),
    });
  } catch (error) {
    console.warn("[langfuse] callback handler unavailable for this run", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function shutdownLangfuse() {
  if (!sdk) return;
  const activeSdk = sdk;
  sdk = undefined;
  setTracingActive(false);
  try {
    await activeSdk.shutdown();
  } catch (error) {
    console.warn("[langfuse] shutdown failed", error instanceof Error ? error.message : error);
  }
}

export function isLangfuseEnabled() {
  return enabled && Boolean(sdk);
}

// Never export model/tool payloads, even if a child lacks a local marker.
export function maskTraceData(data) {
  try { if (typeof data === "string") data = JSON.parse(data); } catch { return "[content-not-captured]"; }
  return data && typeof data === "object" && !Array.isArray(data) ? safeTraceMetadata(data) : "[content-not-captured]";
}

export class PrivacySpanProcessor {
  constructor(delegate) { this.delegate = delegate; }
  onStart(span, context) { try { this.delegate.onStart(span, context); } catch {} }
  onEnd(span) {
    try {
      const view = Object.create(span);
      const attributes = {};
      for (const [key, value] of Object.entries(span.attributes)) {
        if (/^langfuse\.(?:trace|observation)\.metadata\./.test(key)) {
          const field = key.split(".metadata.")[1];
          const safe = safeTraceMetadata({[field]: value});
          if (safe[field] !== undefined) attributes[key] = safe[field];
        }
        else if (["session.id", "langfuse.session.id"].includes(key)) {
          if (typeof value === "string" && /^[a-f0-9-]{8,64}$/i.test(value)) attributes[key] = value;
        }
        else if (key === "langfuse.observation.status_message") attributes[key] = "Operation failed";
        else if (/\.(?:input|output|invocation_parameters|model_parameters)$/.test(key)) attributes[key] = JSON.stringify("[content-not-captured]");
        else if (/\.metadata$/.test(key)) attributes[key] = JSON.stringify(maskTraceData(value));
        else if (/\.(?:usage_details|cost_details)$/.test(key)) {
          if (span.attributes["langfuse.observation.type"] !== "generation") continue;
          let parsed;
          try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { continue; }
          const counts = Object.fromEntries(Object.entries(parsed || {}).filter(([name, count]) => /^(?:input|output|total|input_tokens|output_tokens|total_tokens|input_cached_tokens|input_cache_read|input_cache_creation|reasoning_tokens)$/.test(name) && typeof count === "number" && Number.isFinite(count) && count >= 0));
          attributes[key] = JSON.stringify(counts);
        }
        else if (/^(?:langfuse\.(?:(?:environment|release|version)|trace\.(?:name|session_id|tags)|observation\.(?:type|level|model\.name|usage_details|cost_details|version))|gen_ai\.(?:system|request\.model|response\.model|usage\.[a-z_]+)|llm\.token_count\.[a-z_]+)$/.test(key)) {
          if (typeof value === "number") attributes[key] = value;
          else if (typeof value === "string" && /^[a-z0-9_.:/ -]{1,200}$/i.test(value) && !/Bearer|sk-|pk-/i.test(value)) attributes[key] = value;
        }
      }
      Object.defineProperties(view, {
        name: { value: /^[a-z0-9_.:/-]{1,120}$/i.test(span.name) ? span.name : "instrumentation.observation" },
        attributes: { value: attributes },
        status: { value: { code: span.status.code, ...(span.status.code === 2 ? { message: "Operation failed" } : {}) } },
        events: { value: [] },
        links: { value: [] },
      });
      this.delegate.onEnd(view);
    } catch { /* Export failure is independent of product execution. */ }
  }
  forceFlush() { return this.delegate.forceFlush(); }
  shutdown() { return this.delegate.shutdown(); }
}

// The fallback router does not itself call a provider. Count actual attempts only.
class WorkflowCallbackHandler extends CallbackHandler {
  async handleChatModelStart(llm, messages, runId, parentRunId, extraParams, tags, metadata, name) {
    if (llm.id?.at(-1) === "ApprovalFallbackChatModel") {
      return this.handleChainStart(llm, {}, runId, parentRunId, tags, metadata, "chain", "inference.fallback");
    }
    return super.handleChatModelStart(llm, messages, runId, parentRunId, extraParams, tags, metadata, name);
  }
}
