import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { probe, diffPatch } from "./git.js";

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
