import "./config.js";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

const hasPublicKey = Boolean(process.env.LANGFUSE_PUBLIC_KEY);
const hasSecretKey = Boolean(process.env.LANGFUSE_SECRET_KEY);
const enabled = process.env.NODE_ENV !== "test" && hasPublicKey && hasSecretKey;
let sdk;

export function initializeLangfuse() {
  if (!enabled) {
    if (hasPublicKey !== hasSecretKey) {
      console.warn("[langfuse] disabled: both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required");
    }
    return { enabled: false };
  }
  if (!sdk) {
    try {
      sdk = new NodeSDK({
        spanProcessors: [
          new LangfuseSpanProcessor({
            mask: ({ data }) => redactSensitiveData(data),
            mediaUploadEnabled: false,
          }),
        ],
      });
      sdk.start();
    } catch (error) {
      sdk = undefined;
      console.warn("[langfuse] initialization failed; tracing remains disabled", error instanceof Error ? error.message : error);
      return { enabled: false };
    }
  }
  return { enabled: true };
}

export function createLangfuseHandler({ sessionId, traceMetadata } = {}) {
  if (!enabled || !sdk) return undefined;
  try {
    return new CallbackHandler({
      sessionId,
      tags: ["cravelens", "swiggy-food-agent"],
      version: process.env.npm_package_version,
      traceMetadata,
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
  try {
    await activeSdk.shutdown();
  } catch (error) {
    console.warn("[langfuse] shutdown failed", error instanceof Error ? error.message : error);
  }
}

export function isLangfuseEnabled() {
  return enabled && Boolean(sdk);
}

function redactSensitiveData(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted-key]");
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (/authorization|cookie|token|secret|password/i.test(key)) return [key, "[redacted]"];
    return [key, redactSensitiveData(child, depth + 1)];
  }));
}
