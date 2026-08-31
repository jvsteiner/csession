import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readLines, statTranscript, deriveProjectRoot,
  rewritePrefix, replaceAllText, unresolvedAbsolutePaths, sha256,
} from "./transcript.js";

const FIXTURE = [
  JSON.stringify({ type: "queue-operation", sessionId: "s1", timestamp: "t" }),
  JSON.stringify({ type: "user", cwd: "/Users/jamie/Code/app", version: "2.1.246", sessionId: "s1" }),
  JSON.stringify({ type: "assistant", cwd: "/Users/jamie/Code/app", version: "2.1.246", sessionId: "s1",
    message: { content: [{ type: "text", text: "see /Users/jamie/Code/app/src/a.ts and /Users/jamie/Code/app/src/b.ts and /Users/jamie/Documents/n.md" }] } }),
].join("\n") + "\n";

test("readLines drops the trailing blank and keeps every record", () => {
  assert.equal(readLines(FIXTURE).length, 3);
});

test("statTranscript counts records, cwds and versions", () => {
  const s = statTranscript(readLines(FIXTURE));
  assert.equal(s.recordCount, 3);
  assert.equal(s.cwdCounts["/Users/jamie/Code/app"], 2);
  assert.deepEqual(s.versions, ["2.1.246"]);
});

test("deriveProjectRoot picks the most common cwd", () => {
  const r = deriveProjectRoot(statTranscript(readLines(FIXTURE)));
  assert.equal(r.root, "/Users/jamie/Code/app");
  assert.equal(r.ambiguous, false);
});

test("deriveProjectRoot flags disagreement", () => {
  const stats = { recordCount: 3, cwdCounts: { "/a": 2, "/b": 1 }, versions: [] };
  const r = deriveProjectRoot(stats);
  assert.equal(r.root, "/a");
  assert.equal(r.ambiguous, true);
});

test("deriveProjectRoot throws when no record carries a cwd", () => {
  assert.throws(() => deriveProjectRoot({ recordCount: 1, cwdCounts: {}, versions: [] }));
});

test("rewritePrefix swaps only the given prefix and counts every hit", () => {
  const { lines, replaced } = rewritePrefix(readLines(FIXTURE), "/Users/jamie/Code/app", "/home/jamie/Code/app");
  assert.equal(replaced, 4); // 2 cwd fields + 2 mentions inside the text
  const joined = lines.join("\n");
  assert.ok(joined.includes("/home/jamie/Code/app/src/a.ts"));
  assert.ok(joined.includes("/Users/jamie/Documents/n.md")); // untouched
});

test("PROPERTY: after rewriting, every line still parses and the count is unchanged", () => {
  const before = readLines(FIXTURE);
  const { lines } = rewritePrefix(before, "/Users/jamie/Code/app", "/home/jamie/Code/app");
  assert.equal(lines.length, before.length);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

test("unresolvedAbsolutePaths lists sender paths outside the project root", () => {
  const { lines } = rewritePrefix(readLines(FIXTURE), "/Users/jamie/Code/app", "/home/jamie/Code/app");
  const left = unresolvedAbsolutePaths(lines, "/home/jamie/Code/app");
  assert.deepEqual(left, ["/Users/jamie/Documents/n.md"]);
});

test("sha256 is stable and hex", () => {
  assert.match(sha256("abc"), /^[0-9a-f]{64}$/);
  assert.equal(sha256("abc"), sha256("abc"));
});

test("rewritePrefix requires path boundary: sibling paths are untouched", () => {
  const line = JSON.stringify({ path: "/Users/jamie/Code/app/src/a.ts", sibling: "/Users/jamie/Code/app2/x.ts" });
  const { lines, replaced } = rewritePrefix([line], "/Users/jamie/Code/app", "/home/jamie/Code/app");
  assert.equal(replaced, 1); // only the first path, not the sibling
  assert.ok(lines[0]!.includes("/home/jamie/Code/app/src/a.ts"));
  assert.ok(lines[0]!.includes("/Users/jamie/Code/app2/x.ts")); // untouched
});

test("rewritePrefix validates from argument: rejects quote", () => {
  assert.throws(() => rewritePrefix([], '/Users/jamie/Code"app', "/home/jamie/Code/app"));
});

test("rewritePrefix validates from argument: rejects backslash", () => {
  assert.throws(() => rewritePrefix([], '/Users/jamie/Code\\app', "/home/jamie/Code/app"));
});

test("rewritePrefix validates to argument: rejects quote", () => {
  assert.throws(() => rewritePrefix([], '/Users/jamie/Code/app', '/home/jamie/Code"app'));
});

test("rewritePrefix validates to argument: rejects backslash", () => {
  assert.throws(() => rewritePrefix([], '/Users/jamie/Code/app', '/home/jamie/Code\\app'));
});

test("replaceAllText rewrites <id>.jsonl as well as a bare <id>", () => {
  const lines = [
    JSON.stringify({ sessionId: "old-id", file: "old-id.jsonl" }),
    JSON.stringify({ text: "see old-id and old-id.jsonl again" }),
  ];
  const { lines: out, replaced } = replaceAllText(lines, "old-id", "new-id");
  assert.equal(replaced, 4); // sessionId, file, and 2 mentions in text - "." is not a boundary here
  const joined = out.join("\n");
  assert.ok(joined.includes("new-id.jsonl"));
  assert.ok(!joined.includes("old-id"));
});

test("replaceAllText validates from and to arguments: rejects quote or backslash", () => {
  assert.throws(() => replaceAllText([], 'old"id', "new-id"));
  assert.throws(() => replaceAllText([], "old\\id", "new-id"));
  assert.throws(() => replaceAllText([], "old-id", 'new"id'));
  assert.throws(() => replaceAllText([], "old-id", "new\\id"));
});

test("unresolvedAbsolutePaths recognizes /tmp/ paths", () => {
  const line = JSON.stringify({ text: "temp file at /tmp/build/output.log and project at /Users/jamie/Code/app/src/main.ts" });
  const left = unresolvedAbsolutePaths([line], "/Users/jamie/Code/app");
  assert.ok(left.includes("/tmp/build/output.log"));
});
