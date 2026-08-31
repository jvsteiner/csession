import { test } from "node:test";
import assert from "node:assert/strict";
import { caught } from "../testutil.js";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { writeBundle } from "../bundle.js";
import { importCommand } from "./import.js";
import { sha256 } from "../transcript.js";
import { SCHEMA } from "../manifest.js";
import { encodeProjectDir, sessionFilePath } from "../paths.js";

const SENDER_ROOT = "/Users/sender/Code/app";
const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function receiverRepo(): { root: string; commit: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "csession-imp-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("remote", "add", "origin", "git@github.com:o/r.git");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const commit = g("rev-parse", "HEAD");
  return {
    root,
    commit,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(homedir(), ".claude", "projects", encodeProjectDir(root)), { recursive: true, force: true });
    },
  };
}

/**
 * Two commits, ending on a NAMED branch ("feature") rather than detached - the
 * commit-relation and --worktree tests need real ancestry (an "older" and a "newer"
 * commit) plus a branch to prove the original checkout is not moved off of.
 */
function receiverRepoTwoCommits(): { root: string; older: string; newer: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "csession-imp-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("remote", "add", "origin", "git@github.com:o/r.git");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const older = g("rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "two\n");
  writeFileSync(join(root, "b.txt"), "new\n");
  g("add", "-A");
  g("commit", "-q", "-m", "second");
  const newer = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "feature");
  return {
    root,
    older,
    newer,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(homedir(), ".claude", "projects", encodeProjectDir(root)), { recursive: true, force: true });
    },
  };
}

/** Best-effort teardown for a worktree created by importCommand in a test. */
function removeWorktree(root: string, wtPath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: root });
  } catch {
    // best-effort: fall through to the raw rmSync below regardless
  }
  rmSync(wtPath, { recursive: true, force: true });
  rmSync(join(homedir(), ".claude", "projects", encodeProjectDir(wtPath)), { recursive: true, force: true });
}

function makeBundle(
  dir: string,
  gitOverrides: Record<string, unknown>,
  extra: Record<string, string> = {},
  sessionOverrides: Record<string, unknown> = {},
): string {
  const sessionJsonl =
    [
      JSON.stringify({ type: "user", cwd: SENDER_ROOT, version: "2.1.246", sessionId: SESSION_ID }),
      JSON.stringify({ type: "assistant", cwd: SENDER_ROOT, sessionId: SESSION_ID,
        message: { content: [{ type: "text", text: `${SENDER_ROOT}/a.txt and /Users/sender/Documents/n.md` }] } }),
    ].join("\n") + "\n";
  const manifest = {
    schema: SCHEMA,
    createdAt: "2026-08-31T09:14:22.000Z",
    session: { id: SESSION_ID, projectRoot: SENDER_ROOT, recordCount: 2, sha256: sha256(sessionJsonl), claudeVersions: ["2.1.246"], ...sessionOverrides },
    git: { remote: "git@github.com:o/r.git", branch: "main", commit: "z".repeat(40), dirty: false, untrackedFiles: [], ...gitOverrides },
    redaction: { applied: true, paranoid: false, hits: [] },
  };
  const out = join(dir, "b.ccsession");
  writeBundle(out, { "manifest.json": JSON.stringify(manifest), "session.jsonl": sessionJsonl, ...extra });
  return out;
}

test("import rewrites the project root and writes the transcript", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const bundle = makeBundle(dir, { commit: r.commit });
    const report = importCommand([bundle], { root: r.root }, r.root);
    const dest = sessionFilePath(r.root, SESSION_ID);
    assert.ok(existsSync(dest));
    const text = readFileSync(dest, "utf8");
    assert.ok(text.includes(`${r.root}/a.txt`));
    assert.ok(!text.includes(SENDER_ROOT));
    assert.match(report, /3 paths rewritten/);
    assert.match(report, /claude --resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("paths outside the project root are left alone and reported", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const bundle = makeBundle(dir, { commit: r.commit });
    const report = importCommand([bundle], { root: r.root }, r.root);
    assert.match(report, /\/Users\/sender\/Documents\/n\.md/);
    assert.ok(readFileSync(sessionFilePath(r.root, SESSION_ID), "utf8").includes("/Users/sender/Documents/n.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("a commit mismatch refuses with exit 2 and writes nothing", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const bundle = makeBundle(dir, { commit: "f".repeat(40) });
    const err = caught(() => importCommand([bundle], { root: r.root }, r.root));
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /git -C .* checkout/);
    assert.equal(existsSync(sessionFilePath(r.root, SESSION_ID)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("--force proceeds past a commit mismatch", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const bundle = makeBundle(dir, { commit: "f".repeat(40) });
    importCommand([bundle], { root: r.root, force: true }, r.root);
    assert.ok(existsSync(sessionFilePath(r.root, SESSION_ID)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("a remote mismatch refuses with exit 2", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const bundle = makeBundle(dir, { commit: r.commit, remote: "git@github.com:other/repo.git" });
    const err = caught(() => importCommand([bundle], { root: r.root }, r.root));
    assert.equal(err.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("an existing session id refuses, and --new-id succeeds with a different id", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const bundle = makeBundle(dir, { commit: r.commit });
    importCommand([bundle], { root: r.root }, r.root);

    const err = caught(() => importCommand([bundle], { root: r.root }, r.root));
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /--new-id/);

    const report = importCommand([bundle], { root: r.root, "new-id": true }, r.root);
    const newId = /session ([0-9a-f-]{36})/.exec(report)?.[1];
    assert.ok(newId && newId !== SESSION_ID);
    assert.ok(existsSync(sessionFilePath(r.root, newId!)));
    const text = readFileSync(sessionFilePath(r.root, newId!), "utf8");
    assert.ok(text.includes(newId!));
    assert.ok(!text.includes(SESSION_ID)); // the old id must not survive the swap
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("a corrupted transcript fails the sha check with exit 3 and writes nothing", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const manifest = {
      schema: SCHEMA, createdAt: "2026-08-31T09:14:22.000Z",
      session: { id: SESSION_ID, projectRoot: SENDER_ROOT, recordCount: 1, sha256: "0".repeat(64), claudeVersions: [] },
      git: { remote: "git@github.com:o/r.git", branch: "main", commit: r.commit, dirty: false, untrackedFiles: [] },
      redaction: { applied: true, paranoid: false, hits: [] },
    };
    const out = join(dir, "bad.ccsession");
    writeBundle(out, { "manifest.json": JSON.stringify(manifest), "session.jsonl": "{}\n" });
    const err = caught(() => importCommand([out], { root: r.root }, r.root));
    assert.equal(err.exitCode, 3);
    assert.equal(existsSync(sessionFilePath(r.root, SESSION_ID)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("a patch is reported and NEVER applied", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: r.root, encoding: "utf8" });
    writeFileSync(join(r.root, "a.txt"), "two\n");
    const realPatch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: r.root, encoding: "utf8" });
    execFileSync("git", ["checkout", "--", "a.txt"], { cwd: r.root });
    void patch;

    const bundle = makeBundle(dir, { commit: r.commit, dirty: true }, { "uncommitted.patch": realPatch });
    const report = importCommand([bundle], { root: r.root }, r.root);
    assert.match(report, /git -C .* apply/);
    assert.equal(readFileSync(join(r.root, "a.txt"), "utf8"), "one\n"); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("no bundle path is a user error", () => {
  const err = caught(() => importCommand([], {}, tmpdir()));
  assert.equal(err.exitCode, 1);
});

// The manifest is attacker-controlled and its session id becomes a filesystem path via
// sessionFilePath(). An id of "../../..//tmp/x" resolves clean out of ~/.claude/projects,
// and atomicWrite's recursive mkdir creates the way there - writing the equally
// attacker-controlled transcript. The existing existsSync collision guard does not help:
// the traversal target is a NEW path, so the guard passes.
test("a session id that is not a UUID is refused with exit 3, and no file escapes", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const traversalTarget = `/tmp/csession-traversal-probe-${process.pid}`;
  try {
    const hostile = ["../".repeat(8) + traversalTarget.slice(1), "../../../etc/x", "sub/dir/x", "a b"];
    for (const id of hostile) {
      const bundle = makeBundle(dir, { commit: r.commit }, {}, { id });
      const err = caught(() => importCommand([bundle], { root: r.root }, r.root));
      assert.equal(err.exitCode, 3, `id ${JSON.stringify(id)} must be exit 3`);
      assert.match(err.message, /not a UUID/);
    }
    assert.equal(existsSync(`${traversalTarget}.jsonl`), false, "nothing may be written outside the sessions folder");

    // The legitimate case still works: a real UUID imports.
    const good = makeBundle(dir, { commit: r.commit });
    importCommand([good], { root: r.root }, r.root);
    assert.ok(existsSync(sessionFilePath(r.root, SESSION_ID)));
  } finally {
    rmSync(`${traversalTarget}.jsonl`, { force: true });
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

// inspect strips control characters from manifest strings; import, the more dangerous
// command, did not. A crafted untracked filename can scroll back over and rewrite the
// lines above it - including "They were NOT applied."
test("import sanitizes manifest strings before printing them", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const evil = "\r\x1b[2AThis session had uncommitted changes. They were applied.";
    const bundle = makeBundle(dir, { commit: r.commit, untrackedFiles: [evil] });
    const report = importCommand([bundle], { root: r.root }, r.root);
    assert.ok(!report.includes("\x1b"), "no raw escape may reach the terminal");
    assert.ok(!report.includes("\r"), "no carriage return may reach the terminal");
    // The genuine report must survive the sanitising.
    assert.match(report, /NOTE: 1 untracked file\(s\)/);
    assert.match(report, /claude --resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("import says whether untracked contents are in the bundle or not", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const not = makeBundle(dir, { commit: r.commit, untrackedFiles: ["n.txt"], includedUntracked: false });
    assert.match(importCommand([not], { root: r.root }, r.root), /are NOT included in this bundle/);
    rmSync(sessionFilePath(r.root, SESSION_ID), { force: true });

    const yes = makeBundle(dir, { commit: r.commit, untrackedFiles: ["n.txt"], includedUntracked: true });
    assert.match(importCommand([yes], { root: r.root }, r.root), /ARE included in this bundle/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("--root that does not exist is a user error, exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const bundle = makeBundle(dir, {});
    const err = caught(() => importCommand([bundle], { root: join(dir, "no-such-dir") }, dir));
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /no-such-dir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An unresolved relative --root makes probe() return all nulls, so every safety check
// passes vacuously and the transcript lands under a session folder named
// "..-..-var-folders-..." that Claude Code will never read - while the tool reports
// success.
test("a relative --root works and the transcript lands under the resolved absolute path", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const rel = relative(process.cwd(), r.root);
  try {
    assert.equal(isAbsolute(rel), false, "the test must actually pass a relative path");
    const bundle = makeBundle(dir, { commit: r.commit });
    const report = importCommand([bundle], { root: rel }, r.root);
    const abs = resolve(rel);
    assert.ok(existsSync(sessionFilePath(abs, SESSION_ID)));
    assert.ok(report.includes(`cd ${abs}`), "the resume command must name an absolute root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

// Spawn the real binary: cli.ts caught CsError and RETHREW everything else, so a plain
// Error from transcript.ts reached the user as a Node stack trace and an accidental
// exit 1. A project directory containing a backslash is legal on macOS and Linux and
// exports fine; rewritePrefix then refuses it with an untyped Error on import.
test("CLI process: an untyped internal error still exits 1 with no stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const root = mkdtempSync(join(tmpdir(), "csession-untyped-root-"));
  try {
    // No remote and no commit in the manifest, so the safety checks are skipped and
    // execution reaches rewritePrefix, which rejects a backslash in the project root.
    const bundle = makeBundle(dir, { remote: null, commit: null }, {}, { projectRoot: "/Users/sender/Code/we\\ird" });
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
    const p = spawnSync(process.execPath, [cliPath, "import", bundle, "--root", root], { encoding: "utf8" });
    assert.equal(p.status, 1);
    assert.match(p.stderr, /^error: /m);
    assert.match(p.stderr, /quote or backslash/);
    assert.doesNotMatch(p.stderr, /at .*\(.*:\d+:\d+\)/);
    assert.equal(existsSync(sessionFilePath(root, SESSION_ID)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(join(homedir(), ".claude", "projects", encodeProjectDir(root)), { recursive: true, force: true });
  }
});

test("no --root and no matching checkout is a user error", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "csession-elsewhere-"));
  try {
    const bundle = makeBundle(dir, {});
    const err = caught(() => importCommand([bundle], {}, elsewhere));
    assert.equal(err.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// --- commit relationship reporting (FEATURE 1) -----------------------------

// Two SHAs with no stated relationship forced a human to work out, unaided, that being
// 249 commits ahead is nothing like a genuine divergence. commitRelation() computes
// that relationship; this proves the sentence it produces actually reaches the report.
test("commit mismatch message states how the two commits relate", () => {
  const r = receiverRepoTwoCommits();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const bundle = makeBundle(dir, { commit: r.older });
    const err = caught(() => importCommand([bundle], { root: r.root }, r.root));
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /ahead of the bundle/);
    assert.match(err.message, /1 commit/);
    assert.match(err.message, /2 files? differ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

// --- --worktree (FEATURE 2) -------------------------------------------------

// The three tests that matter most: the original checkout must not move, the session
// must land in the worktree (paths rewritten to IT, not the original root), and an
// unfetched commit must fail cleanly rather than create a worktree at nothing.

test("--worktree imports into a new worktree at the bundle's commit, leaving the current checkout untouched", () => {
  const r = receiverRepoTwoCommits();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const wtPath = join(dirname(r.root), `${basename(r.root)}-csession-${r.older.slice(0, 8)}`);
  const branchBefore = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: r.root, encoding: "utf8" }).trim();
  try {
    const bundle = makeBundle(dir, { commit: r.older });
    const report = importCommand([bundle], { root: r.root, worktree: true }, r.root);

    // The session lands in the worktree, not the original root, with paths rewritten to it.
    assert.ok(existsSync(sessionFilePath(wtPath, SESSION_ID)));
    assert.equal(existsSync(sessionFilePath(r.root, SESSION_ID)), false);
    const text = readFileSync(sessionFilePath(wtPath, SESSION_ID), "utf8");
    assert.ok(text.includes(`${wtPath}/a.txt`));
    assert.ok(!text.includes(SENDER_ROOT));
    assert.ok(!text.includes(`${r.root}/a.txt`), "must be rewritten to the worktree, not the original root");
    assert.match(report, /worktree/i);
    assert.match(report, new RegExp(`cd ${wtPath}`));
    assert.match(report, new RegExp(`worktree remove ${wtPath}`));

    // The current checkout is untouched: same branch, no diff.
    assert.equal(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: r.root, encoding: "utf8" }).trim(),
      branchBefore,
    );
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: r.root, encoding: "utf8" }), "");
  } finally {
    removeWorktree(r.root, wtPath);
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("--worktree with a commit not present locally fails with a UserError and creates no worktree", () => {
  const r = receiverRepo();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const missing = "f".repeat(40);
  const wtPath = join(dirname(r.root), `${basename(r.root)}-csession-${missing.slice(0, 8)}`);
  try {
    const bundle = makeBundle(dir, { commit: missing });
    const err = caught(() => importCommand([bundle], { root: r.root, worktree: true }, r.root));
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /fetch/i);
    assert.equal(existsSync(wtPath), false);
    assert.equal(existsSync(sessionFilePath(r.root, SESSION_ID)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("--worktree wins when combined with --force", () => {
  const r = receiverRepoTwoCommits();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const wtPath = join(dirname(r.root), `${basename(r.root)}-csession-${r.older.slice(0, 8)}`);
  try {
    const bundle = makeBundle(dir, { commit: r.older });
    importCommand([bundle], { root: r.root, worktree: true, force: true }, r.root);
    assert.ok(existsSync(wtPath), "a worktree must still be created even though --force was also passed");
    assert.equal(existsSync(sessionFilePath(r.root, SESSION_ID)), false, "the session must not land in the original root");
  } finally {
    removeWorktree(r.root, wtPath);
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("--worktree does not bypass the remote mismatch check", () => {
  const r = receiverRepoTwoCommits();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const wtPath = join(dirname(r.root), `${basename(r.root)}-csession-${r.older.slice(0, 8)}`);
  try {
    const bundle = makeBundle(dir, { commit: r.older, remote: "git@github.com:other/repo.git" });
    const err = caught(() => importCommand([bundle], { root: r.root, worktree: true }, r.root));
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /remote mismatch/);
    assert.equal(existsSync(wtPath), false, "no worktree should be created when the remote check refuses first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("--worktree does not bypass the transcript checksum check", () => {
  const r = receiverRepoTwoCommits();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  try {
    const manifest = {
      schema: SCHEMA,
      createdAt: "2026-08-31T09:14:22.000Z",
      session: { id: SESSION_ID, projectRoot: SENDER_ROOT, recordCount: 1, sha256: "0".repeat(64), claudeVersions: [] },
      git: { remote: "git@github.com:o/r.git", branch: "main", commit: r.older, dirty: false, untrackedFiles: [] },
      redaction: { applied: true, paranoid: false, hits: [] },
    };
    const out = join(dir, "bad.ccsession");
    writeBundle(out, { "manifest.json": JSON.stringify(manifest), "session.jsonl": "{}\n" });
    const err = caught(() => importCommand([out], { root: r.root, worktree: true }, r.root));
    assert.equal(err.exitCode, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("--worktree refuses to reuse an existing path at that location", () => {
  const r = receiverRepoTwoCommits();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const wtPath = join(dirname(r.root), `${basename(r.root)}-csession-${r.older.slice(0, 8)}`);
  try {
    const bundle = makeBundle(dir, { commit: r.older });
    importCommand([bundle], { root: r.root, worktree: true }, r.root); // first import creates the worktree

    const err = caught(() => importCommand([bundle], { root: r.root, worktree: true }, r.root));
    assert.equal(err.exitCode, 1);
    assert.match(err.message, new RegExp(wtPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    removeWorktree(r.root, wtPath);
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});

test("--worktree still enforces the session id collision check, against the worktree's own session folder", () => {
  const r = receiverRepoTwoCommits();
  const dir = mkdtempSync(join(tmpdir(), "csession-b-"));
  const wtPath = join(dirname(r.root), `${basename(r.root)}-csession-${r.older.slice(0, 8)}`);
  try {
    const bundle = makeBundle(dir, { commit: r.older });
    // Pre-create a colliding session file in the ~/.claude/projects folder the
    // worktree will map to - the worktree checkout itself does not exist yet.
    mkdirSync(dirname(sessionFilePath(wtPath, SESSION_ID)), { recursive: true });
    writeFileSync(sessionFilePath(wtPath, SESSION_ID), "existing\n");

    const err = caught(() => importCommand([bundle], { root: r.root, worktree: true }, r.root));
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /already exists/);
  } finally {
    removeWorktree(r.root, wtPath);
    rmSync(dir, { recursive: true, force: true });
    r.cleanup();
  }
});
