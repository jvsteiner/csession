import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { exportCommand } from "./commands/export.js";
import { importCommand } from "./commands/import.js";
import { encodeProjectDir, sessionFilePath } from "./paths.js";

function repoWithSession(prefix: string, sessionId: string): { root: string; cleanup: () => void } {
  const made = mkdtempSync(join(tmpdir(), prefix));
  const g0 = (...a: string[]) => execFileSync("git", a, { cwd: made, encoding: "utf8" });
  g0("init", "-q", "-b", "main");
  // See the note in export.test.ts: use git's resolved toplevel, not mkdtemp's path.
  const root = g0("rev-parse", "--show-toplevel").trim();
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("remote", "add", "origin", "git@github.com:o/r.git");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const dir = join(homedir(), ".claude", "projects", encodeProjectDir(root));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: "user", cwd: root, version: "2.1.246", sessionId }),
      JSON.stringify({ type: "assistant", cwd: root, sessionId,
        message: { content: [{ type: "text", text: `wrote ${root}/a.txt; key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789` }] } }),
    ].join("\n") + "\n",
  );
  return { root, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); } };
}

test("E2E: a session exported from one root imports cleanly into another", () => {
  const id = "99999999-8888-7777-6666-555555555555";
  const sender = repoWithSession("csession-e2e-send-", id);
  const receiver = repoWithSession("csession-e2e-recv-", "unused-id");
  const work = mkdtempSync(join(tmpdir(), "csession-e2e-work-"));
  try {
    // Put the receiver on the same commit as the sender by replaying the tree.
    const senderCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sender.root, encoding: "utf8" }).trim();

    const bundle = join(work, "trip.ccsession");
    exportCommand([id], { out: bundle }, sender.root, new Date("2026-08-31T09:14:22Z"));

    // The receiver's working tree must be untouched by import. Capture its status
    // before and after; the bundle lives under `work`, outside receiver.root, so it
    // (and any temp patch file import writes) cannot show up as an untracked file.
    const statusBefore = execFileSync("git", ["status", "--porcelain"], {
      cwd: receiver.root,
      encoding: "utf8",
    });

    // Commits differ between the two throwaway repos, so --force is expected here.
    const report = importCommand([bundle], { root: receiver.root, force: true }, receiver.root);

    const statusAfter = execFileSync("git", ["status", "--porcelain"], {
      cwd: receiver.root,
      encoding: "utf8",
    });
    assert.equal(statusAfter, statusBefore, "import must not touch the receiver's working tree");

    const text = readFileSync(sessionFilePath(receiver.root, id), "utf8");
    assert.ok(text.includes(`${receiver.root}/a.txt`), "project root was rewritten");
    assert.ok(!text.includes(sender.root), "no sender path survives");
    assert.ok(!text.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "secret was redacted on export");
    assert.ok(text.includes("[REDACTED:github-token]"));
    assert.match(report, /claude --resume/);
    assert.ok(senderCommit.length === 40);

    for (const line of text.split("\n").filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line), "every line still parses after the round trip");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(sessionFilePath(receiver.root, id), { force: true });
    sender.cleanup();
    receiver.cleanup();
  }
});
