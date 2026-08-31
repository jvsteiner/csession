import { randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBundle, atomicWrite } from "../bundle.js";
import { parseManifest } from "../manifest.js";
import { readLines, rewritePrefix, replaceAllText, unresolvedAbsolutePaths, sha256 } from "../transcript.js";
import { probe, applyCheck } from "../git.js";
import { sessionFilePath } from "../paths.js";
import { resolveProjectRoot } from "../args.js";
import { UserError, SafetyError, CorruptBundleError } from "../errors.js";
import { safe } from "../sanitize.js";
import { existsSync } from "node:fs";

/**
 * Claude Code session ids are UUIDs. Anything else is a malformed bundle.
 *
 * This is a hard gate rather than a nicety because the id is attacker-controlled and
 * gets used in two dangerous places: sessionFilePath() interpolates it into a
 * filesystem path (an id of "../../../../tmp/pwned" escapes the sessions folder
 * entirely, and atomicWrite's recursive mkdir happily creates the way there, with the
 * equally attacker-controlled transcript as the content), and buildReport prints it
 * inside a `claude --resume <id>` command we invite the reader to run.
 */
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function importCommand(
  positional: string[],
  flags: Record<string, string | boolean>,
  cwd: string,
): string {
  const path = positional[0];
  if (!path) throw new UserError("import needs a bundle path: csession import FILE");

  const files = readBundle(path);
  const m = parseManifest(files["manifest.json"]!);
  // Before the id is used for ANYTHING - see SESSION_ID_RE above.
  if (!SESSION_ID_RE.test(m.session.id)) {
    throw new CorruptBundleError(
      `manifest session id is not a UUID: "${safe(m.session.id, 80)}". ` +
        `That string would become a file path and a command to run; refusing.`,
    );
  }
  const sessionJsonl = files["session.jsonl"]!;

  const actual = sha256(sessionJsonl);
  if (actual !== m.session.sha256) {
    throw new CorruptBundleError(
      `transcript checksum does not match the manifest (expected ${m.session.sha256}, got ${actual})`,
    );
  }

  const root = resolveLocalRoot(flags, cwd, m.git.remote);
  const force = flags["force"] === true;
  const local = probe(root);

  // Every `m.*` below is a manifest string - see sanitize.ts. `local.*` and `root` are
  // ours: read from the receiver's own repo, or validated here.
  if (m.git.remote && local.remote && m.git.remote !== local.remote && !force) {
    throw new SafetyError(
      `remote mismatch.\n  bundle: ${safe(m.git.remote)}\n  local:  ${local.remote}\n` +
        `This may be a different repository. Re-run with --force if you are sure.`,
    );
  }

  if (m.git.commit && local.commit && m.git.commit !== local.commit && !force) {
    throw new SafetyError(
      `commit mismatch.\n  bundle: ${safe(m.git.commit)}\n  local:  ${local.commit}\n\n` +
        `The conversation assumes the bundle's tree. To match it:\n` +
        `  git -C ${root} checkout ${safe(m.git.commit)}\n\n` +
        `Or re-run with --force to import anyway.`,
    );
  }

  const newId = flags["new-id"] === true ? randomUUID() : m.session.id;
  const dest = sessionFilePath(root, newId);
  if (existsSync(dest)) {
    throw new SafetyError(
      `session ${newId} already exists at ${dest}. Re-run with --new-id to import it under a fresh id.`,
    );
  }

  let lines = readLines(sessionJsonl);
  const rewritten = rewritePrefix(lines, m.session.projectRoot, root);
  lines = rewritten.lines;
  if (newId !== m.session.id) {
    lines = replaceAllText(lines, m.session.id, newId).lines;
  }
  const unresolved = unresolvedAbsolutePaths(lines, root);

  atomicWrite(dest, lines.join("\n") + "\n");

  return buildReport(m, root, newId, rewritten.replaced, unresolved, files, force);
}

function resolveLocalRoot(
  flags: Record<string, string | boolean>,
  cwd: string,
  bundleRemote: string | null,
): string {
  const explicit = flags["root"];
  if (typeof explicit === "string") {
    // A relative or non-existent --root is worse than an error: probe() returns all
    // nulls for it, so every safety check below passes VACUOUSLY, the transcript lands
    // in a folder Claude Code will never read, and we report success with a resume
    // command that cannot work. Resolve it too - the value ends up in a session folder
    // name and in that printed command, both of which must be absolute.
    const abs = resolve(explicit);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new UserError(`--root ${explicit} is not an existing directory (resolved to ${abs})`);
    }
    return abs;
  }

  const here = resolveProjectRoot(cwd);
  const local = probe(here);
  if (bundleRemote && local.remote === bundleRemote) return here;

  throw new UserError(
    `cannot work out where this repository lives here.\n` +
      `  bundle remote: ${bundleRemote === null ? "none recorded" : safe(bundleRemote)}\n` +
      `  current dir:   ${here} (remote: ${local.remote ?? "none"})\n\n` +
      `Re-run from inside the right checkout, or pass --root PATH.`,
  );
}

function buildReport(
  m: ReturnType<typeof parseManifest>,
  root: string,
  newId: string,
  replaced: number,
  unresolved: string[],
  files: Record<string, string>,
  force: boolean,
): string {
  const l: string[] = [];
  l.push(`session ${newId}  (${m.session.recordCount} records)`);
  if (newId !== m.session.id) l.push(`  (original id was ${safe(m.session.id)})`);
  l.push(`${replaced} paths rewritten to ${root}`);
  if (unresolved.length > 0) {
    l.push(`${unresolved.length} path(s) left as-is (not under the project root):`);
    for (const p of unresolved.slice(0, 20)) l.push(`  ${p}`);
    if (unresolved.length > 20) l.push(`  ... and ${unresolved.length - 20} more`);
  }
  if (m.git.untrackedFiles.length > 0) {
    const n = m.git.untrackedFiles.length;
    // Saying "not in the bundle" unconditionally was wrong whenever the sender used
    // --include-untracked: the contents are right there in uncommitted.patch.
    l.push(
      m.git.includedUntracked
        ? `NOTE: ${n} untracked file(s) referenced by this session ARE included in this bundle, in uncommitted.patch:`
        : `NOTE: ${n} untracked file(s) referenced by this session are NOT included in this bundle:`,
    );
    for (const f of m.git.untrackedFiles) l.push(`  ${safe(f)}`);
  }
  const patch = files["uncommitted.patch"];
  if (patch) {
    // A predictable path in the shared /tmp namespace (e.g. csession-<id>.patch) lets
    // anyone who has seen the bundle pre-plant a symlink there for writeFileSync to
    // follow. mkdtempSync makes a private, unpredictable directory first.
    const patchDir = mkdtempSync(join(tmpdir(), "csession-patch-"));
    const patchPath = join(patchDir, `csession-${newId}.patch`);
    writeFileSync(patchPath, patch);
    const check = applyCheck(root, patchPath);
    l.push("");
    l.push(`This session had uncommitted changes. They were NOT applied.`);
    l.push(`  patch (temporary file): ${patchPath}`);
    l.push(`  applies:    ${check.ok ? "cleanly" : `NO - ${check.output}`}`);
    l.push(`  to apply:   git -C ${root} apply ${patchPath}`);
  }
  if (force) {
    l.push("");
    l.push("WARNING: --force was used. The history may describe a tree you do not have.");
  }
  l.push("");
  l.push(`Resume with:  cd ${root} && claude --resume ${newId}`);
  return l.join("\n");
}
