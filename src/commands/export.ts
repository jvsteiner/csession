import { readFileSync } from "node:fs";
import { listSessionFiles, sessionFilePath } from "../paths.js";
import { readLines, statTranscript, deriveProjectRoot, sha256 } from "../transcript.js";
import { redact } from "../redact.js";
import { probe, diffPatch, untrackedPatch } from "../git.js";
import { writeBundle } from "../bundle.js";
import { SCHEMA, type Manifest } from "../manifest.js";
import { UserError } from "../errors.js";
import { resolveProjectRoot } from "../args.js";

export function exportCommand(
  positional: string[],
  flags: Record<string, string | boolean>,
  cwd: string,
  now: Date,
): string {
  const out = flags["out"];
  const dryRun = flags["dry-run"] === true;
  if (typeof out !== "string" && !dryRun) {
    throw new UserError("export needs an output path: csession export [id] -o FILE");
  }

  const projectRoot = resolveProjectRoot(cwd);
  const available = listSessionFiles(projectRoot);
  if (available.length === 0) {
    throw new UserError(`no sessions found for ${projectRoot}`);
  }

  const requested = positional[0];
  const chosen = requested
    ? available.find((s) => s.id === requested)
    : available[0];
  if (!chosen) {
    throw new UserError(
      `no session "${requested}" for ${projectRoot}. Run: csession list`,
    );
  }

  const raw = readFileSync(sessionFilePath(projectRoot, chosen.id), "utf8");
  const originalLines = readLines(raw);
  const stats = statTranscript(originalLines);
  const derived = deriveProjectRoot(stats);

  const notes: string[] = [];
  if (!requested) notes.push(`No id given; chose the newest session ${chosen.id}.`);
  if (derived.ambiguous) {
    notes.push(`Records disagree on cwd; using the most common: ${derived.root}`);
  }

  const applyRedaction = flags["no-redact"] !== true;
  const paranoid = flags["paranoid"] === true;
  const { lines, hits } = applyRedaction
    ? redact(originalLines, { paranoid })
    : { lines: originalLines, hits: [] };
  const sessionJsonl = lines.join("\n") + "\n";

  const git = probe(derived.root);
  const includeUntracked = flags["include-untracked"] === true;
  let patch = git.dirty || includeUntracked ? diffPatch(derived.root) : "";
  if (includeUntracked) {
    patch += untrackedPatch(derived.root, git.untrackedFiles);
  }

  const manifest: Manifest = {
    schema: SCHEMA,
    createdAt: now.toISOString(),
    session: {
      id: chosen.id,
      projectRoot: derived.root,
      recordCount: lines.length,
      sha256: sha256(sessionJsonl),
      claudeVersions: stats.versions,
    },
    git: {
      remote: git.remote,
      branch: git.branch,
      commit: git.commit,
      dirty: git.dirty,
      untrackedFiles: git.untrackedFiles,
    },
    redaction: { applied: applyRedaction, paranoid, hits },
  };

  const report = buildReport(manifest, patch, notes, dryRun, includeUntracked);
  if (dryRun) return report;

  const files: Record<string, string> = {
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "session.jsonl": sessionJsonl,
  };
  if (patch.trim().length > 0) files["uncommitted.patch"] = patch;

  writeBundle(out as string, files);
  return `${report}\n\nWrote ${out}`;
}

function buildReport(
  m: Manifest,
  patch: string,
  notes: string[],
  dryRun: boolean,
  includeUntracked: boolean,
): string {
  const l: string[] = [];
  if (dryRun) l.push("DRY RUN - nothing was written.");
  l.push(...notes);
  l.push(`session   ${m.session.id}  (${m.session.recordCount} records)`);
  l.push(`root      ${m.session.projectRoot}`);
  l.push(`git       ${m.git.branch ?? "?"} @ ${(m.git.commit ?? "?").slice(0, 12)}  dirty=${m.git.dirty}`);
  if (patch.trim().length > 0) {
    const kb = Math.round(Buffer.byteLength(patch) / 1024);
    l.push(`patch     ${kb}K`);
    if (kb > 1024) l.push(`WARNING: the patch is ${kb}K. Consider committing first.`);
  }
  if (m.git.untrackedFiles.length > 0) {
    const verb = includeUntracked ? "included" : "NOT included";
    l.push(`untracked ${m.git.untrackedFiles.length} file(s) ${verb}: ${m.git.untrackedFiles.join(", ")}`);
  }
  if (m.redaction.applied) {
    l.push(
      m.redaction.hits.length === 0
        ? "redaction no matches"
        : `redaction ${m.redaction.hits.map((h) => `${h.rule}x${h.count}`).join(", ")}`,
    );
  } else {
    l.push("redaction DISABLED (--no-redact). This bundle may contain secrets.");
  }
  l.push("");
  l.push("Redaction is best-effort. A secret that is split across lines, encoded,");
  l.push("or oddly shaped can still get through. Inspect before you send.");
  return l.join("\n");
}
