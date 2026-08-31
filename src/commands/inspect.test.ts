import { test } from "node:test";
import assert from "node:assert/strict";
import { caught } from "../testutil.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundle } from "../bundle.js";
import { inspectCommand } from "./inspect.js";
import { sha256 } from "../transcript.js";
import { SCHEMA } from "../manifest.js";
import { spawnSync } from "node:child_process";

function bundleAt(dir: string, sessionJsonl: string, overrides: Record<string, unknown> = {}): string {
  const manifest = {
    schema: SCHEMA,
    createdAt: "2026-08-31T09:14:22.000Z",
    session: { id: "s1", projectRoot: "/Users/jamie/Code/app", recordCount: 1, sha256: sha256(sessionJsonl), claudeVersions: ["2.1.246"] },
    git: { remote: "git@github.com:o/r.git", branch: "main", commit: "c".repeat(40), dirty: false, untrackedFiles: [] },
    redaction: { applied: true, paranoid: false, hits: [{ rule: "github-token", count: 2 }] },
    ...overrides,
  };
  const out = join(dir, "b.ccsession");
  writeBundle(out, { "manifest.json": JSON.stringify(manifest), "session.jsonl": sessionJsonl });
  return out;
}

test("inspect prints the manifest summary without extracting anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-insp-"));
  try {
    const out = bundleAt(dir, '{"a":1}\n');
    const report = inspectCommand([out]);
    assert.match(report, /s1/);
    assert.match(report, /\/Users\/jamie\/Code\/app/);
    assert.match(report, /github-token/);
    assert.match(report, /sha256 OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect reports a sha mismatch rather than staying quiet", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-insp-"));
  try {
    const out = bundleAt(dir, '{"a":1}\n', { session: { id: "s1", projectRoot: "/x", recordCount: 1, sha256: "0".repeat(64), claudeVersions: [] } });
    assert.match(inspectCommand([out]), /sha256 MISMATCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect with no file is a user error", () => {
  const err = caught(() => inspectCommand([]));
  assert.equal(err.exitCode, 1);
});

test("inspect against a garbage file throws CorruptBundleError with exit code 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-insp-garbage-"));
  try {
    const junkPath = join(dir, "garbage.ccsession");
    writeFileSync(junkPath, "this is not a tar file at all");

    const r = spawnSync(process.execPath, ["dist/cli.js", "inspect", junkPath], {
      cwd: "/Users/jamie/Code/csession-phase-1",
      encoding: "utf8",
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /^error: /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
