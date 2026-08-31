import { test } from "node:test";
import assert from "node:assert/strict";
import { caught } from "../testutil.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
    // Regression: `.map(safe)` passed the array index as safe()'s `max`, so element 0
    // was truncated to nothing and every bundle reported `versions  …(truncated)`.
    assert.match(report, /versions {2}2\.1\.246/);
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

    const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
    const r = spawnSync(process.execPath, [cliPath, "inspect", junkPath], {
      encoding: "utf8",
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /^error: /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect prints redaction DISABLED warning when redaction is not applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-insp-"));
  try {
    const out = bundleAt(dir, '{"a":1}\n', { redaction: { applied: false, paranoid: false, hits: [] } });
    const report = inspectCommand([out]);
    assert.match(report, /redaction DISABLED - this bundle may contain secrets/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect says whether untracked contents are in the bundle or not", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-insp-"));
  try {
    const g = { remote: null, branch: "main", commit: "c".repeat(40), dirty: true, untrackedFiles: ["n.txt"] };

    const not = bundleAt(dir, '{"a":1}\n', { git: { ...g, includedUntracked: false } });
    assert.match(inspectCommand([not]), /untracked NOT included in this bundle: n\.txt/);

    const yes = bundleAt(dir, '{"a":1}\n', { git: { ...g, includedUntracked: true } });
    const report = inspectCommand([yes]);
    assert.match(report, /untracked included in this bundle: n\.txt/);
    assert.doesNotMatch(report, /NOT included/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect sanitizes manifest strings to prevent ANSI injection attacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-insp-"));
  try {
    // ESC[2K clears the line; ESC[0G moves cursor to start; \r carriage return would visually erase earlier content.
    // A hostile bundle could embed "sha256 OK" in projectRoot to fool the reader into trusting a bad sha.
    const maliciousRoot = "[2K\rsha256 OK";
    const out = bundleAt(dir, '{"a":1}\n', { session: { id: "s1", projectRoot: maliciousRoot, recordCount: 1, sha256: "0".repeat(64), claudeVersions: [] } });
    const report = inspectCommand([out]);
    // The real sha verdict must still appear
    assert.match(report, /sha256 MISMATCH/);
    // The escape sequence itself must not appear in the output
    assert.ok(!report.includes("\x1b"));
    // The malicious root must be stripped of control chars
    assert.ok(!report.includes("[2K\rsha256 OK"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
