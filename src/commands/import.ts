import { randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBundle, atomicWrite } from "../bundle.js";
import { parseManifest } from "../manifest.js";
import { readLines, rewritePrefix, replaceAllText, unresolvedAbsolutePaths, sha256 } from "../transcript.js";
import { probe, applyCheck } from "../git.js";
import { sessionFilePath } from "../paths.js";
import { resolveProjectRoot } from "../args.js";
import { UserError, SafetyError, CorruptBundleError } from "../errors.js";
import { existsSync } from "node:fs";

export function importCommand(
  positional: string[],
  flags: Record<string, string | boolean>,
  cwd: string,
): string {
  const path = positional[0];
  if (!path) throw new UserError("import needs a bundle path: csession import FILE");

  const files = readBundle(path);
  const m = parseManifest(files["manifest.json"]!);
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

  if (m.git.remote && local.remote && m.git.remote !== local.remote && !force) {
    throw new SafetyError(
      `remote mismatch.\n  bundle: ${m.git.remote}\n  local:  ${local.remote}\n` +
        `This may be a different repository. Re-run with --force if you are sure.`,
    );
  }

  if (m.git.commit && local.commit && m.git.commit !== local.commit && !force) {
    throw new SafetyError(
      `commit mismatch.\n  bundle: ${m.git.commit}\n  local:  ${local.commit}\n\n` +
        `The conversation assumes the bundle's tree. To match it:\n` +
        `  git -C ${root} checkout ${m.git.commit}\n\n` +
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
  if (typeof explicit === "string") return explicit;

  const here = resolveProjectRoot(cwd);
  const local = probe(here);
  if (bundleRemote && local.remote === bundleRemote) return here;

  throw new UserError(
    `cannot work out where this repository lives here.\n` +
      `  bundle remote: ${bundleRemote ?? "none recorded"}\n` +
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
  if (newId !== m.session.id) l.push(`  (original id was ${m.session.id})`);
  l.push(`${replaced} paths rewritten to ${root}`);
  if (unresolved.length > 0) {
    l.push(`${unresolved.length} path(s) left as-is (not under the project root):`);
    for (const p of unresolved.slice(0, 20)) l.push(`  ${p}`);
    if (unresolved.length > 20) l.push(`  ... and ${unresolved.length - 20} more`);
  }
  if (m.git.untrackedFiles.length > 0) {
    l.push(`NOTE: ${m.git.untrackedFiles.length} file(s) referenced by this session are not in the bundle:`);
    for (const f of m.git.untrackedFiles) l.push(`  ${f}`);
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
