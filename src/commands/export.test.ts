import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportCommand } from "./export.js";
import { readBundle } from "../bundle.js";
import { sha256 } from "../transcript.js";
import { parseManifest } from "../manifest.js";
import { encodeProjectDir } from "../paths.js";
import { caught } from "../testutil.js";
import { execFileSync, spawnSync } from "node:child_process";

const NOW = new Date("2026-08-31T09:14:22Z");

/** Build a real repo plus a real session file in the real projects dir, then clean both up. */
function scaffold(): { root: string; sessionId: string; cleanup: () => void } {
  const made = mkdtempSync(join(tmpdir(), "csession-exp-"));
  const g0 = (...a: string[]) => execFileSync("git", a, { cwd: made, encoding: "utf8" });
  g0("init", "-q", "-b", "main");
  // macOS: /var is a symlink to /private/var. resolveProjectRoot() shells out to
  // `git rev-parse --show-toplevel`, which returns the RESOLVED path - so the
  // session folder must be keyed off that, not off the mkdtemp path.
  const root = g0("rev-parse", "--show-toplevel").trim();
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("remote", "add", "origin", "git@github.com:o/r.git");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const sessionId = "11111111-2222-3333-4444-555555555555";
  const dir = join(homedir(), ".claude", "projects", encodeProjectDir(root));
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", cwd: root, version: "2.1.246", sessionId }),
    JSON.stringify({ type: "assistant", cwd: root, version: "2.1.246", sessionId,
      message: { content: [{ type: "text", text: `edited ${root}/a.txt with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789` }] } }),
  ];
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");

  return {
    root,
    sessionId,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("export writes a bundle whose manifest describes the session and repo", () => {
  const s = scaffold();
  const out = join(s.root, "..", `${s.sessionId}.ccsession`);
  try {
    exportCommand([s.sessionId], { out }, s.root, NOW);
    const files = readBundle(out);
    const m = parseManifest(files["manifest.json"]!);
    assert.equal(m.session.id, s.sessionId);
    assert.equal(m.session.projectRoot, s.root);
    assert.equal(m.session.recordCount, 2);
    assert.equal(m.git.remote, "git@github.com:o/r.git");
    assert.equal(m.git.branch, "main");
    assert.equal(m.git.dirty, false);
    assert.equal(m.createdAt, "2026-08-31T09:14:22.000Z");
  } finally {
    rmSync(out, { force: true });
    s.cleanup();
  }
});

test("export redacts by default and records the hit as a count", () => {
  const s = scaffold();
  const out = join(s.root, "..", "redacted.ccsession");
  try {
    exportCommand([s.sessionId], { out }, s.root, NOW);
    const files = readBundle(out);
    assert.ok(!files["session.jsonl"]!.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
    assert.ok(files["session.jsonl"]!.includes("[REDACTED:github-token]"));
    const m = parseManifest(files["manifest.json"]!);
    assert.deepEqual(m.redaction.hits, [{ rule: "github-token", count: 1 }]);
    assert.equal(m.redaction.applied, true);
  } finally {
    rmSync(out, { force: true });
    s.cleanup();
  }
});

test("the manifest sha256 matches the shipped transcript, after redaction", () => {
  const s = scaffold();
  const out = join(s.root, "..", "sha.ccsession");
  try {
    exportCommand([s.sessionId], { out }, s.root, NOW);
    const files = readBundle(out);
    const m = parseManifest(files["manifest.json"]!);
    assert.equal(m.session.sha256, sha256(files["session.jsonl"]!));
  } finally {
    rmSync(out, { force: true });
    s.cleanup();
  }
});

test("--no-redact ships the secret and says so in the manifest", () => {
  const s = scaffold();
  const out = join(s.root, "..", "raw.ccsession");
  try {
    exportCommand([s.sessionId], { out, "no-redact": true }, s.root, NOW);
    const files = readBundle(out);
    assert.ok(files["session.jsonl"]!.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
    assert.equal(parseManifest(files["manifest.json"]!).redaction.applied, false);
  } finally {
    rmSync(out, { force: true });
    s.cleanup();
  }
});

test("--dry-run reports but writes nothing", () => {
  const s = scaffold();
  const out = join(s.root, "..", `never.ccsession`);
  try {
    const report = exportCommand([s.sessionId], { out, "dry-run": true }, s.root, NOW);
    assert.equal(existsSync(out), false);
    assert.match(report, /github-token/);
    assert.match(report, /dry run/i);
  } finally {
    s.cleanup();
  }
});

test("a dirty tree produces uncommitted.patch and dirty: true", () => {
  const s = scaffold();
  const out = join(s.root, "..", "dirty.ccsession");
  try {
    writeFileSync(join(s.root, "a.txt"), "two\n");
    exportCommand([s.sessionId], { out }, s.root, NOW);
    const files = readBundle(out);
    assert.ok("uncommitted.patch" in files);
    assert.match(files["uncommitted.patch"]!, /a\.txt/);
    assert.equal(parseManifest(files["manifest.json"]!).git.dirty, true);
  } finally {
    rmSync(out, { force: true });
    s.cleanup();
  }
});

test("untracked names go in the manifest but their contents never do", () => {
  const s = scaffold();
  const out = join(s.root, "..", "untracked.ccsession");
  try {
    writeFileSync(join(s.root, "secret-notes.txt"), "TOP SECRET BODY\n");
    exportCommand([s.sessionId], { out }, s.root, NOW);
    const files = readBundle(out);
    assert.deepEqual(parseManifest(files["manifest.json"]!).git.untrackedFiles, ["secret-notes.txt"]);
    for (const content of Object.values(files)) {
      assert.ok(!content.includes("TOP SECRET BODY"));
    }
  } finally {
    rmSync(out, { force: true });
    s.cleanup();
  }
});

test("--include-untracked puts an untracked file's name AND content into uncommitted.patch", () => {
  const s = scaffold();
  const out = join(s.root, "..", "untracked-included.ccsession");
  try {
    writeFileSync(join(s.root, "new-thing.txt"), "brand new untracked content\n");
    exportCommand([s.sessionId], { out, "include-untracked": true }, s.root, NOW);
    const files = readBundle(out);
    assert.ok("uncommitted.patch" in files);
    assert.match(files["uncommitted.patch"]!, /new-thing\.txt/);
    assert.match(files["uncommitted.patch"]!, /brand new untracked content/);
  } finally {
    rmSync(out, { force: true });
    s.cleanup();
  }
});

// --include-untracked must never become --include-secrets: a gitignored file is
// filtered out by probe()'s `ls-files --others --exclude-standard` before
// untrackedPatch() ever sees its name, so it must stay out of every bundle entry
// even when the flag is set.
test("--include-untracked never leaks a .gitignore'd file's content", () => {
  const s = scaffold();
  const out = join(s.root, "..", "ignored-secret.ccsession");
  try {
    writeFileSync(join(s.root, ".gitignore"), ".env\n");
    writeFileSync(join(s.root, ".env"), "TOTALLY_IGNORED_SECRET_9f8c3d21\n");
    exportCommand([s.sessionId], { out, "include-untracked": true }, s.root, NOW);
    const files = readBundle(out);
    for (const content of Object.values(files)) {
      assert.ok(!content.includes("TOTALLY_IGNORED_SECRET_9f8c3d21"));
    }
  } finally {
    rmSync(out, { force: true });
    s.cleanup();
  }
});

test("an unknown session id is a user error, exit code 1", () => {
  const s = scaffold();
  try {
    const err = caught(() => exportCommand(["nope"], { out: "/tmp/x.ccsession" }, s.root, NOW));
    assert.equal(err.exitCode, 1);
  } finally {
    s.cleanup();
  }
});

test("omitting -o is a user error", () => {
  const s = scaffold();
  try {
    const err = caught(() => exportCommand([s.sessionId], {}, s.root, NOW));
    assert.equal(err.exitCode, 1);
  } finally {
    s.cleanup();
  }
});

// Spawn the real binary so cli.ts's catch block actually executes. Every other test
// in this file calls exportCommand() directly, so none of them prove that a thrown
// CsError reaches cli.ts's `catch (e) { if (e instanceof CsError) ... }`, gets
// formatted as `error: <message>`, and exits with the error's own code - as opposed
// to escaping as an uncaught exception, which Node's default handler ALSO exits with
// code 1, but by printing a stack trace instead of "error: ...". A bare
// `assert.equal(r.status, 1)` cannot tell those two paths apart - it would pass
// identically even if the entire catch block were deleted. The stderr assertions
// below are what actually distinguish "the mapping ran" from "the process merely
// died at exit code 1 for some other reason."
test("CLI process: exporting from a project with no sessions exits with code 1", () => {
  const made = mkdtempSync(join(tmpdir(), "csession-exp-noroot-"));
  const g0 = (...a: string[]) => execFileSync("git", a, { cwd: made, encoding: "utf8" });
  g0("init", "-q", "-b", "main");
  // Resolve through git for the same symlink reason as scaffold() above, even though
  // this repo never gets a session folder - keep the two test setups consistent.
  const root = g0("rev-parse", "--show-toplevel").trim();
  const outDir = mkdtempSync(join(tmpdir(), "csession-exp-out-"));
  const out = join(outDir, "x.ccsession");
  // dist/cli.js sits one directory up from this compiled test file (dist/commands/export.test.js).
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  try {
    const r = spawnSync(process.execPath, [cliPath, "export", "definitely-not-a-session", "-o", out], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.equal(existsSync(out), false);
    // Emitted only by cli.ts's catch block; Node's default uncaught-exception
    // handler never prints this prefix.
    assert.match(r.stderr, /^error: /m);
    // No stack frames: if the error had instead escaped as an uncaught exception,
    // Node would print one here.
    assert.doesNotMatch(r.stderr, /at .*\(.*:\d+:\d+\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
