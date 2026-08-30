import { spawnSync } from "node:child_process";

export function run(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trimEnd(),
    stderr: (r.stderr ?? "").trimEnd(),
  };
}

export interface GitInfo {
  remote: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  untrackedFiles: string[];
}

export function probe(root: string): GitInfo {
  if (!run(root, ["rev-parse", "--is-inside-work-tree"]).ok) {
    return { remote: null, branch: null, commit: null, dirty: false, untrackedFiles: [] };
  }
  const remote = run(root, ["remote", "get-url", "origin"]);
  const branch = run(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = run(root, ["rev-parse", "HEAD"]);
  // --quiet exits non-zero when there is a tracked change. Untracked and
  // ignored files do not affect it, which is exactly what we want.
  const dirty = !run(root, ["diff", "--quiet", "HEAD"]).ok;
  // --exclude-standard honours .gitignore, so ignored files never appear.
  const untracked = run(root, ["ls-files", "--others", "--exclude-standard"]);

  return {
    remote: remote.ok ? remote.stdout : null,
    branch: branch.ok ? branch.stdout : null,
    commit: commit.ok ? commit.stdout : null,
    dirty,
    untrackedFiles: untracked.ok && untracked.stdout ? untracked.stdout.split("\n") : [],
  };
}

/** Every change to a file git already knows about. Binary-safe so it applies cleanly. */
export function diffPatch(root: string): string {
  const r = run(root, ["diff", "--binary", "HEAD"]);
  // A failed diff is not "no changes" — conflating them yields a bundle that
  // claims dirty with no patch. Throw loudly instead of silently returning "".
  if (!r.ok) {
    throw new Error(`git diff failed in ${root}: ${r.stderr || "(no stderr)"}`);
  }
  return r.stdout + "\n";
}

export function applyCheck(root: string, patchPath: string): { ok: boolean; output: string } {
  const r = run(root, ["apply", "--check", patchPath]);
  return { ok: r.ok, output: r.stderr || r.stdout };
}
