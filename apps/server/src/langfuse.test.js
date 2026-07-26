import { describe, expect, it } from "vitest";
import { createLangfuseHandler, initializeLangfuse, isLangfuseEnabled, shutdownLangfuse } from "./langfuse.js";

describe("Langfuse integration", () => {
  it("stays disabled during tests and without a running SDK", async () => {
    expect(isLangfuseEnabled()).toBe(false);
    expect(initializeLangfuse()).toEqual({ enabled: false });
    expect(createLangfuseHandler({ sessionId: "thread-test" })).toBeUndefined();
    await expect(shutdownLangfuse()).resolves.toBeUndefined();
  });
});
