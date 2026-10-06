export function createAgentRepairBudget({ state, maxValidationFailures = 3, maxMissingToolCalls = 3, timeoutMs = 180_000, now = Date.now } = {}) {
  const expiresAt = now() + timeoutMs;
  const failures = new Map();
  let missing = 0;
  let exhausted;
  const failure = (message) => Object.assign(new Error(message), { code: "INFERENCE_REPAIR_EXHAUSTED" });
  return {
    check() {
      if (exhausted) throw exhausted;
      if (now() >= expiresAt) throw Object.assign(new Error("Cart agent exceeded its elapsed-time budget"), { code: "INFERENCE_TIMEOUT" });
    },
    beforeModelCall() {
      this.check();
      state.modelCallCount += 1;
    },
    invalidArguments(tool) {
      const count = (failures.get(tool) || 0) + 1;
      failures.set(tool, count);
      if (count >= maxValidationFailures) exhausted = failure(`Could not repair ${tool} arguments after ${count} attempts`);
      return count;
    },
    validArguments(tool) { failures.delete(tool); },
    toolCompleted() { missing = 0; },
    missingToolCall() {
      missing += 1;
      if (missing >= maxMissingToolCalls) exhausted = failure(`Local model failed to invoke a required tool ${missing} times`);
      this.check();
      return missing;
    },
  };
}
