import { CorruptBundleError } from "./errors.js";

export const SCHEMA = 1;

export interface RedactionHit {
  rule: string;
  count: number;
}

export interface Manifest {
  schema: number;
  createdAt: string;
  session: {
    id: string;
    projectRoot: string;
    recordCount: number;
    sha256: string;
    claudeVersions: string[];
  };
  git: {
    remote: string | null;
    branch: string | null;
    commit: string | null;
    dirty: boolean;
    untrackedFiles: string[];
    /** True when those files' CONTENTS ship in uncommitted.patch (export --include-untracked). */
    includedUntracked: boolean;
  };
  redaction: {
    applied: boolean;
    paranoid: boolean;
    hits: RedactionHit[];
  };
}

function req(obj: Record<string, unknown>, key: string, kind: string, path: string): unknown {
  const v = obj[key];
  const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const want = kind === "array" ? "array" : kind;
  const ok = kind === "array" ? Array.isArray(v) : kind === "nullable-string" ? v === null || typeof v === "string" : actual === want;
  if (!ok) throw new CorruptBundleError(`manifest: ${path}.${key} must be ${kind}, got ${actual}`);
  return v;
}

/**
 * `Array.isArray` says nothing about what is IN the array. Every consumer of these
 * arrays treats the elements as strings - inspect maps them through safe(), which calls
 * `.replace()` - so a non-string element becomes a TypeError with no exitCode: a
 * stack trace and exit 1, when the contract says a malformed bundle is exit 3.
 */
function stringArray(o: Record<string, unknown>, key: string, path: string): string[] {
  const arr = req(o, key, "array", path) as unknown[];
  arr.forEach((v, i) => {
    if (typeof v !== "string") {
      const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      throw new CorruptBundleError(`manifest: ${path}.${key}[${i}] must be string, got ${actual}`);
    }
  });
  return arr as string[];
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new CorruptBundleError(`manifest: ${path} must be an object`);
  }
  return v as Record<string, unknown>;
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CorruptBundleError("manifest.json is not valid JSON");
  }
  const m = obj(raw, "manifest");

  const schema = req(m, "schema", "number", "manifest") as number;
  if (schema !== SCHEMA) {
    throw new CorruptBundleError(
      `bundle uses schema ${schema}; this csession understands schema ${SCHEMA}. Upgrade csession.`,
    );
  }

  const s = obj(req(m, "session", "object", "manifest"), "manifest.session");
  const g = obj(req(m, "git", "object", "manifest"), "manifest.git");
  const r = obj(req(m, "redaction", "object", "manifest"), "manifest.redaction");

  const hits = (req(r, "hits", "array", "manifest.redaction") as unknown[]).map((h, i) => {
    const hit = obj(h, `manifest.redaction.hits[${i}]`);
    const extra = Object.keys(hit).filter((k) => k !== "rule" && k !== "count");
    if (extra.length > 0) {
      throw new CorruptBundleError(
        `manifest.redaction.hits[${i}] has unexpected field(s): ${extra.join(", ")}. Hits carry counts only.`,
      );
    }
    return {
      rule: req(hit, "rule", "string", `manifest.redaction.hits[${i}]`) as string,
      count: req(hit, "count", "number", `manifest.redaction.hits[${i}]`) as number,
    };
  });

  return {
    schema,
    createdAt: req(m, "createdAt", "string", "manifest") as string,
    session: {
      id: req(s, "id", "string", "manifest.session") as string,
      projectRoot: req(s, "projectRoot", "string", "manifest.session") as string,
      recordCount: req(s, "recordCount", "number", "manifest.session") as number,
      sha256: req(s, "sha256", "string", "manifest.session") as string,
      claudeVersions: stringArray(s, "claudeVersions", "manifest.session"),
    },
    git: {
      remote: req(g, "remote", "nullable-string", "manifest.git") as string | null,
      branch: req(g, "branch", "nullable-string", "manifest.git") as string | null,
      commit: req(g, "commit", "nullable-string", "manifest.git") as string | null,
      dirty: req(g, "dirty", "boolean", "manifest.git") as boolean,
      untrackedFiles: stringArray(g, "untrackedFiles", "manifest.git"),
      // Absent in bundles written before this field existed, so it defaults rather than
      // failing - schema 1 stays schema 1. False is the conservative default: unless the
      // bundle says the contents shipped, both readers tell the receiver they did not.
      includedUntracked:
        g["includedUntracked"] === undefined
          ? false
          : (req(g, "includedUntracked", "boolean", "manifest.git") as boolean),
    },
    redaction: {
      applied: req(r, "applied", "boolean", "manifest.redaction") as boolean,
      paranoid: req(r, "paranoid", "boolean", "manifest.redaction") as boolean,
      hits,
    },
  };
}
