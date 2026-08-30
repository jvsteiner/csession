import { test } from "node:test";
import assert from "node:assert/strict";
import { caught } from "./testutil.js";

test("caught returns the thrown error", () => {
  const testError = new Error("test error");
  const err = caught(() => {
    throw testError;
  });
  assert.equal(err, testError);
  assert.equal(err.message, "test error");
});

test("caught throws if the function does not throw", () => {
  let err!: Error;
  try {
    caught(() => {
      // does not throw
    });
    assert.fail("should have thrown");
  } catch (e) {
    err = e as Error;
  }
  assert.match(err.message, /expected the call to throw/);
});
