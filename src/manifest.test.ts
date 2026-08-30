import { test } from "node:test";
import assert from "node:assert";
import { parseManifest, SCHEMA } from "./manifest.js";
import { caught } from "./testutil.js";

const GOOD = {
  schema: SCHEMA,
  createdAt: "2026-08-31T09:14:22Z",
  session: {
    id: "abc-123",
    projectRoot: "/Users/jamie/Code/app",
    recordCount: 3,
    sha256: "a".repeat(64),
    claudeVersions: ["2.1.246"],
  },
  git: { remote: "git@github.com:o/r.git", branch: "main", commit: "b".repeat(40), dirty: false, untrackedFiles: [] },
  redaction: { applied: true, paranoid: false, hits: [{ rule: "github-token", count: 2 }] },
};

test("parseManifest accepts a well-formed manifest", () => {
  const m = parseManifest(JSON.stringify(GOOD));
  assert.equal(m.session.id, "abc-123");
  assert.equal(m.redaction.hits[0]!.count, 2);
});

test("parseManifest rejects a newer schema with exit code 3", () => {
  const err = caught(() => parseManifest(JSON.stringify({ ...GOOD, schema: 999 })));
  assert.equal(err.exitCode, 3);
  assert.match(err.message, /schema/i);
});

test("parseManifest rejects unparseable JSON", () => {
  const err = caught(() => parseManifest("{not json"));
  assert.equal(err.exitCode, 3);
});

test("parseManifest rejects a missing required field", () => {
  const bad = JSON.parse(JSON.stringify(GOOD));
  delete bad.session.projectRoot;
  const err = caught(() => parseManifest(JSON.stringify(bad)));
  assert.equal(err.exitCode, 3);
  assert.match(err.message, /projectRoot/);
});

test("a redaction hit carrying a value is rejected - counts only, never values", () => {
  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.redaction.hits[0].value = "ghp_leak";
  const err = caught(() => parseManifest(JSON.stringify(bad)));
  assert.match(err.message, /unexpected field/i);
});
