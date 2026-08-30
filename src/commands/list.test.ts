import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectRoot } from "../args.js";
import { execFileSync } from "node:child_process";

test("resolveProjectRoot returns the git root when inside a repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-root-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const sub = join(dir, "a", "b");
    execFileSync("mkdir", ["-p", sub]);
    // realpath because macOS /var is a symlink to /private/var
    const expected = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: sub, encoding: "utf8" }).trim();
    assert.equal(resolveProjectRoot(sub), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProjectRoot falls back to the directory itself outside a repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-noroot-"));
  try {
    assert.equal(resolveProjectRoot(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
