import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { probe, diffPatch, commitRelation, addWorktree, run } from "./git.js";

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "csession-git-"));
  const g = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("remote", "add", "origin", "git@github.com:o/r.git");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return dir;
}

test("probe reads remote, branch and commit from a clean repo", () => {
  const dir = newRepo();
  try {
    const info = probe(dir);
    assert.equal(info.remote, "git@github.com:o/r.git");
    assert.equal(info.branch, "main");
    assert.match(info.commit!, /^[0-9a-f]{40}$/);
    assert.equal(info.dirty, false);
    assert.deepEqual(info.untrackedFiles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tracked edit makes the repo dirty and lands in the patch", () => {
  const dir = newRepo();
  try {
    writeFileSync(join(dir, "tracked.txt"), "two\n");
    assert.equal(probe(dir).dirty, true);
    assert.match(diffPatch(dir), /tracked\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("untracked files are listed but never appear in the patch", () => {
  const dir = newRepo();
  try {
    writeFileSync(join(dir, "new.txt"), "hello\n");
    assert.deepEqual(probe(dir).untrackedFiles, ["new.txt"]);
    assert.ok(!diffPatch(dir).includes("new.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignored files are neither listed nor patched", () => {
  const dir = newRepo();
  try {
    writeFileSync(join(dir, "ignored.txt"), "SECRET\n");
    const info = probe(dir);
    assert.deepEqual(info.untrackedFiles, []);
    assert.equal(info.dirty, false);
    assert.ok(!diffPatch(dir).includes("ignored.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a staged new file IS in the patch, because add makes it tracked", () => {
  const dir = newRepo();
  try {
    writeFileSync(join(dir, "added.txt"), "hi\n");
    execFileSync("git", ["add", "added.txt"], { cwd: dir });
    assert.match(diffPatch(dir), /added\.txt/);
    assert.deepEqual(probe(dir).untrackedFiles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe on a non-repo returns nulls rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-norepo-"));
  try {
    const info = probe(dir);
    assert.equal(info.commit, null);
    assert.equal(info.remote, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diffPatch on a non-repo throws rather than returning empty string", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-norepo-"));
  try {
    assert.throws(() => {
      diffPatch(dir);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- commitRelation -----------------------------------------------------

test("commitRelation: same commit on both sides", () => {
  const dir = newRepo();
  try {
    const head = run(dir, ["rev-parse", "HEAD"]).stdout;
    assert.deepEqual(commitRelation(dir, head, head), { kind: "same" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitRelation: local ahead reports commit and file counts", () => {
  const dir = newRepo();
  try {
    const base = run(dir, ["rev-parse", "HEAD"]).stdout;
    writeFileSync(join(dir, "tracked.txt"), "two\n");
    writeFileSync(join(dir, "second.txt"), "hi\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: dir });
    const head = run(dir, ["rev-parse", "HEAD"]).stdout;

    assert.deepEqual(commitRelation(dir, base, head), {
      kind: "local-ahead",
      commits: 1,
      files: 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitRelation: local behind reports commit and file counts", () => {
  const dir = newRepo();
  try {
    const base = run(dir, ["rev-parse", "HEAD"]).stdout;
    writeFileSync(join(dir, "tracked.txt"), "two\n");
    writeFileSync(join(dir, "second.txt"), "hi\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: dir });
    const head = run(dir, ["rev-parse", "HEAD"]).stdout;

    // local (base) is BEHIND the bundle (head) here.
    assert.deepEqual(commitRelation(dir, head, base), {
      kind: "local-behind",
      commits: 1,
      files: 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitRelation: diverged when neither is an ancestor of the other", () => {
  const dir = newRepo();
  try {
    const base = run(dir, ["rev-parse", "HEAD"]).stdout;
    writeFileSync(join(dir, "tracked.txt"), "branch-a\n");
    execFileSync("git", ["commit", "-q", "-am", "a"], { cwd: dir });
    const a = run(dir, ["rev-parse", "HEAD"]).stdout;

    execFileSync("git", ["checkout", "-q", base], { cwd: dir });
    writeFileSync(join(dir, "tracked.txt"), "branch-b\n");
    execFileSync("git", ["commit", "-q", "-am", "b"], { cwd: dir });
    const b = run(dir, ["rev-parse", "HEAD"]).stdout;

    assert.deepEqual(commitRelation(dir, a, b), { kind: "diverged" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitRelation: a commit absent from the local repo is unknown, not a throw", () => {
  const dir = newRepo();
  try {
    const head = run(dir, ["rev-parse", "HEAD"]).stdout;
    assert.deepEqual(commitRelation(dir, "f".repeat(40), head), { kind: "unknown" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitRelation: a non-repo is unknown, not a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-norepo-"));
  try {
    assert.deepEqual(commitRelation(dir, "a".repeat(40), "b".repeat(40)), { kind: "unknown" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- addWorktree ----------------------------------------------------------

test("addWorktree creates a detached worktree at the given commit without touching the current checkout", () => {
  const dir = newRepo();
  const wt = join(tmpdir(), `csession-wt-${process.pid}-${Date.now()}`);
  try {
    const head = run(dir, ["rev-parse", "HEAD"]).stdout;
    const branchBefore = run(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;

    addWorktree(dir, wt, head);

    assert.ok(existsSync(wt));
    assert.ok(existsSync(join(wt, "tracked.txt")));
    assert.equal(run(wt, ["rev-parse", "HEAD"]).stdout, head);
    assert.equal(run(wt, ["symbolic-ref", "-q", "HEAD"]).ok, false, "the worktree must be detached");

    // The original checkout is untouched.
    assert.equal(run(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout, branchBefore);
    assert.equal(run(dir, ["status", "--porcelain"]).stdout, "");
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir }).toString();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addWorktree throws a plain Error carrying stderr when git fails", () => {
  const dir = newRepo();
  try {
    assert.throws(
      () => addWorktree(dir, join(tmpdir(), "csession-wt-bad"), "f".repeat(40)),
      (e: unknown) => e instanceof Error && !(e instanceof Error && "exitCode" in e) && e.message.length > 0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
