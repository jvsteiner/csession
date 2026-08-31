import { test } from "node:test";
import assert from "node:assert/strict";
import { caught } from "../testutil.js";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

function makeBundle(dir: string, gitOverrides: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const sessionJsonl =
    [
      JSON.stringify({ type: "user", cwd: SENDER_ROOT, version: "2.1.246", sessionId: SESSION_ID }),
      JSON.stringify({ type: "assistant", cwd: SENDER_ROOT, sessionId: SESSION_ID,
        message: { content: [{ type: "text", text: `${SENDER_ROOT}/a.txt and /Users/sender/Documents/n.md` }] } }),
    ].join("\n") + "\n";
  const manifest = {
    schema: SCHEMA,
    createdAt: "2026-08-31T09:14:22.000Z",
    session: { id: SESSION_ID, projectRoot: SENDER_ROOT, recordCount: 2, sha256: sha256(sessionJsonl), claudeVersions: ["2.1.246"] },
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
