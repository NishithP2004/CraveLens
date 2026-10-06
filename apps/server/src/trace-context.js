import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { startActiveObservation, propagateAttributes } from "@langfuse/tracing";

const storage = new AsyncLocalStorage();
let active = false;
export function setTracingActive(value) { active = value; }
export function traceContext() { return storage.getStore() || {}; }
const safeNames = /^(?:[a-z][a-z0-9_.:/-]{0,100})$/i;
export function safeTraceMetadata(value = {}) {
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (["runId", "streamId", "sessionId"].includes(key) && typeof child === "string" && /^[a-f0-9-]{8,64}$/i.test(child)) result[key] = child;
    else if (["operation", "phase", "origin", "provider", "model", "tool", "outcome", "errorCode"].includes(key) && typeof child === "string" && safeNames.test(child) && !/^(sk-|pk-|Bearer)/i.test(child)) result[key] = child;
    else if (["attempt", "durationMs", "statusCode"].includes(key) && (Number.isFinite(child) || typeof child === "string" && /^\d{1,12}$/.test(child))) result[key] = String(child);
  }
  return result;
}
const update = (span, attributes) => { try { span?.update(attributes); } catch { /* Observability never changes execution. */ } };

export async function traceOperation(name, metadata, operation, { type = "span" } = {}) {
  const parent = traceContext();
  const context = { ...parent, ...safeTraceMetadata(metadata), sessionId: parent.sessionId || safeTraceMetadata(metadata).sessionId || crypto.randomUUID() };
  return storage.run(context, async () => {
    if (!active) return operation();
    let called = false, result, failure;
    const run = async (span) => {
      called = true;
      const started = performance.now();
      update(span, { metadata: safeTraceMetadata(context) });
      try { result = await operation(); update(span, { metadata: safeTraceMetadata({ ...context, outcome: "success", durationMs: Math.round(performance.now() - started) }) }); }
      catch (error) {
        failure = error;
        update(span, { level: "ERROR", statusMessage: "Operation failed", metadata: safeTraceMetadata({ ...context, outcome: "error", errorCode: error?.code || error?.name || "Error", statusCode: error?.statusCode, durationMs: Math.round(performance.now() - started) }) });
      }
      return result;
    };
    try {
      await propagateAttributes({ sessionId: context.sessionId, metadata: safeTraceMetadata(context), tags: ["cravelens"] },
        () => startActiveObservation(name, run, { asType: type }));
    } catch { /* The operation must never be retried because telemetry failed. */ }
    if (!called) return operation();
    if (failure) throw failure;
    return result;
  });
}

export function tracedOperation(name, operation, metadata = () => ({}), options) {
  return (...args) => traceOperation(name, metadata(...args), () => operation(...args), options);
}
