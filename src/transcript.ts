import { createHash } from "node:crypto";

export function readLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

export interface TranscriptStats {
  recordCount: number;
  cwdCounts: Record<string, number>;
  versions: string[];
}

/**
 * Records are read one line at a time and never re-serialised. A line that
 * does not parse is still counted and still shipped — the tool does not get
 * to decide that a transcript is malformed.
 */
export function statTranscript(lines: string[]): TranscriptStats {
  const cwdCounts: Record<string, number> = {};
  const versions = new Set<string>();
  for (const line of lines) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && typeof rec === "object") {
      const r = rec as Record<string, unknown>;
      if (typeof r["cwd"] === "string") {
        const c = r["cwd"];
        cwdCounts[c] = (cwdCounts[c] ?? 0) + 1;
      }
      if (typeof r["version"] === "string") versions.add(r["version"]);
    }
  }
  return { recordCount: lines.length, cwdCounts, versions: [...versions].sort() };
}

export function deriveProjectRoot(stats: TranscriptStats): { root: string; ambiguous: boolean } {
  const entries = Object.entries(stats.cwdCounts);
  if (entries.length === 0) {
    throw new Error("no record in this transcript carries a cwd field; cannot determine the project root");
  }
  entries.sort((a, b) => b[1] - a[1]);
  return { root: entries[0]![0], ambiguous: entries.length > 1 };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swaps one prefix, everywhere, as plain text. Validates that from and to
 * contain no quote or backslash, which would break JSON. Anchors the match
 * to path boundaries to prevent sibling paths from being rewritten.
 */
export function rewritePrefix(lines: string[], from: string, to: string): { lines: string[]; replaced: number } {
  if (from.includes('"') || from.includes("\\")) {
    throw new Error(`rewritePrefix: from argument contains quote or backslash: ${from}`);
  }
  if (to.includes('"') || to.includes("\\")) {
    throw new Error(`rewritePrefix: to argument contains quote or backslash: ${to}`);
  }
  const re = new RegExp(escapeRegExp(from) + "(?![A-Za-z0-9._-])", "g");
  let replaced = 0;
  const out = lines.map((line) =>
    line.replace(re, () => {
      replaced += 1;
      return to;
    }),
  );
  return { lines: out, replaced };
}

// Matches paths that are sender-specific and not portable. Excludes /usr, /etc,
// /bin, /opt: those are system paths that mean the same on both machines and
// would flood the report if listed.
const ABS_PATH = /(?:\/Users\/|\/home\/|\/root\/|\/tmp\/|\/private\/var\/|\/var\/folders\/)[A-Za-z0-9._+\-\/]+/g;

/** Distinct absolute home-rooted or temp paths that are NOT under `root`, sorted. */
export function unresolvedAbsolutePaths(lines: string[], root: string): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(ABS_PATH)) {
      if (!m[0].startsWith(root)) found.add(m[0]);
    }
  }
  return [...found].sort();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
