import { describe, expect, it } from "vitest";
import { createAgentRepairBudget } from "../src/agent-repair-budget.js";
import { invokeModelWithToolChoiceRetry } from "../src/swiggy-agent.js";

describe("cart agent repair budget", () => {
  it("counts internal provider retries without a cumulative inference cap", async () => {
    const state = { modelCallCount: 0, modelCallLimit: 2 };
    const budget = createAgentRepairBudget({ state });
    let requests = 0;
    await expect(invokeModelWithToolChoiceRetry({ tools: [] }, async () => {
      budget.beforeModelCall();
      requests += 1;
      throw new Error("503 service unavailable");
    }, { sleep: async () => {} })).rejects.toThrow("503 service unavailable");
    expect(requests).toBe(4);
    expect(state.modelCallCount).toBe(4);
    for (let index = 0; index < 100; index++) budget.beforeModelCall();
    expect(state.modelCallCount).toBe(104);
  });
  it("retains invalid-cart failures across other successful tools", () => {
    const budget = createAgentRepairBudget({ state: { modelCallCount: 0, modelCallLimit: 20 } });
    budget.invalidArguments("update_food_cart");
    budget.validArguments("search_menu");
    budget.invalidArguments("update_food_cart");
    budget.check();
    budget.invalidArguments("update_food_cart");
    expect(() => budget.beforeModelCall()).toThrow(/repair update_food_cart/);
  });
  it("bounds missing tool responses across separate model steps", () => {
    const budget = createAgentRepairBudget({ state: { modelCallCount: 0, modelCallLimit: 20 } });
    expect(budget.missingToolCall()).toBe(1);
    budget.beforeModelCall();
    expect(budget.missingToolCall()).toBe(2);
    budget.beforeModelCall();
    expect(() => budget.missingToolCall()).toThrow(/required tool 3 times/);
  });
  it("resets missing-tool failures only when a tool actually completes", () => {
    const state = { modelCallCount: 0, modelCallLimit: 20 };
    const budget = createAgentRepairBudget({ state });
    budget.beforeModelCall();
    budget.missingToolCall();
    budget.missingToolCall();
    budget.toolCompleted();
    expect(budget.missingToolCall()).toBe(1);
    expect(state.modelCallCount).toBe(1);
    expect(budget.missingToolCall()).toBe(2);
    expect(() => budget.missingToolCall()).toThrow(/required tool 3 times/);
  });
  it("rejects expired runs before further inference or tool work", () => {
    const budget = createAgentRepairBudget({ state: { modelCallCount: 0, modelCallLimit: 20 }, timeoutMs: 0 });
    expect(() => budget.check()).toThrow(/elapsed-time budget/);
  });
});
