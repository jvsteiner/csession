import { readBundle } from "../bundle.js";
import { parseManifest } from "../manifest.js";
import { sha256 } from "../transcript.js";
import { UserError } from "../errors.js";

/**
 * Manifest strings come from whoever built the bundle. parseManifest checks their
 * TYPE, never their CONTENT. Printed raw, an embedded ANSI or control sequence can
 * visually overwrite earlier lines of this report - including the sha verdict - and
 * inspect exists precisely so a person can trust what they are reading.
 */
function safe(s: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  return stripped.length > max ? stripped.slice(0, max) + "…(truncated)" : stripped;
}

export function inspectCommand(positional: string[]): string {
  const path = positional[0];
  if (!path) throw new UserError("inspect needs a bundle path: csession inspect FILE");

  const files = readBundle(path);
  const m = parseManifest(files["manifest.json"]!);
  const actual = sha256(files["session.jsonl"]!);
  const shaLine = actual === m.session.sha256 ? "sha256 OK" : `sha256 MISMATCH (expected ${m.session.sha256}, got ${actual})`;

  const l: string[] = [];
  l.push(`bundle    ${path}`);
  l.push(`created   ${m.createdAt}`);
  l.push(`session   ${safe(m.session.id)}  (${m.session.recordCount} records)`);
  l.push(`root      ${safe(m.session.projectRoot)}`);
  l.push(`versions  ${m.session.claudeVersions.map(safe).join(", ") || "unknown"}`);
  l.push(`git       ${safe(m.git.branch ?? "?")} @ ${safe((m.git.commit ?? "?").slice(0, 12))}  dirty=${m.git.dirty}`);
  l.push(`remote    ${safe(m.git.remote ?? "none")}`);
  l.push(`patch     ${"uncommitted.patch" in files ? `${Math.round(Buffer.byteLength(files["uncommitted.patch"]!) / 1024)}K` : "none"}`);
  if (m.git.untrackedFiles.length > 0) {
    l.push(`untracked not in this bundle: ${m.git.untrackedFiles.map(safe).join(", ")}`);
  }
  l.push(
    m.redaction.applied
      ? `redaction ${m.redaction.hits.map((h) => `${safe(h.rule)}x${h.count}`).join(", ") || "no matches"}${m.redaction.paranoid ? " (paranoid)" : ""}`
      : "redaction DISABLED - this bundle may contain secrets",
  );
  l.push(shaLine);
  return l.join("\n");
}
