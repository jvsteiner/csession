import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./args.js";

test("parses a command with positionals", () => {
  const a = parseArgs(["export", "abc-123"]);
  assert.equal(a.command, "export");
  assert.deepEqual(a.positional, ["abc-123"]);
});

test("parses long flags with values, in both forms", () => {
  assert.equal(parseArgs(["import", "--root", "/x"]).flags["root"], "/x");
  assert.equal(parseArgs(["import", "--root=/x"]).flags["root"], "/x");
});

test("parses boolean flags", () => {
  const a = parseArgs(["export", "--dry-run", "--paranoid"]);
  assert.equal(a.flags["dry-run"], true);
  assert.equal(a.flags["paranoid"], true);
});

test("parses -o as shorthand for --out", () => {
  assert.equal(parseArgs(["export", "-o", "x.ccsession"]).flags["out"], "x.ccsession");
});

test("an empty argv yields the help command", () => {
  assert.equal(parseArgs([]).command, "help");
});
