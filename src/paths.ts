import { homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Claude Code names a project folder by taking the working directory and
 * replacing every "/" with "-". This is lossy: "/a/b-c" and "/a/b/c" both
 * encode to "-a-b-c". Encoding is safe; decoding is not, which is why the
 * project root is derived from the transcript instead.
 */
export function encodeProjectDir(root: string): string {
  const trimmed = root.endsWith("/") && root.length > 1 ? root.slice(0, -1) : root;
  return trimmed.replaceAll("/", "-");
}

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function sessionDirFor(root: string): string {
  return join(claudeProjectsDir(), encodeProjectDir(root));
}

export function sessionFilePath(root: string, sessionId: string): string {
  return join(sessionDirFor(root), `${sessionId}.jsonl`);
}

export interface SessionFileInfo {
  id: string;
  path: string;
  mtimeMs: number;
  bytes: number;
}

/** Sessions for a project root, newest first. Returns [] if the folder is absent. */
export function listSessionFiles(root: string): SessionFileInfo[] {
  const dir = sessionDirFor(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => {
      const path = join(dir, n);
      const st = statSync(path);
      return { id: n.slice(0, -".jsonl".length), path, mtimeMs: st.mtimeMs, bytes: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
