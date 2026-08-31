import { test } from "node:test";
import assert from "node:assert/strict";
import { safe } from "./sanitize.js";

test("safe strips control characters and truncates, leaving printable text alone", () => {
  assert.equal(safe("\r\x1b[2Aoverwrite"), "??[2Aoverwrite");
  assert.equal(safe("/Users/jamie/Code/app"), "/Users/jamie/Code/app");
  assert.equal(safe("x".repeat(10), 4), "xxxx…(truncated)");
});
