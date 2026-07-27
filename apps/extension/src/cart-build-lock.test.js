import assert from "node:assert/strict";
import test from "node:test";
import { createCartBuildLock } from "./cart-build-lock.js";

test("allows only one in-flight cart build for the same dish and video", () => {
  const lock = createCartBuildLock();
  const claim = lock.claim("video-1", "miso chicken ramen");

  assert.equal(typeof claim, "string");
  assert.equal(lock.claim("video-1", "miso chicken ramen"), null);
  assert.notEqual(lock.claim("video-1", "mint soda"), null);
  assert.notEqual(lock.claim("video-2", "miso chicken ramen"), null);

  lock.release(claim);
  assert.notEqual(lock.claim("video-1", "miso chicken ramen"), null);
});
