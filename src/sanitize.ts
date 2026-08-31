/**
 * Manifest strings come from whoever built the bundle. parseManifest checks their
 * TYPE, never their CONTENT. Printed raw, an embedded ANSI or control sequence can
 * visually overwrite earlier lines of a report - including inspect's sha verdict, or
 * import's "This session had uncommitted changes. They were NOT applied." - and both
 * commands exist precisely so a person can trust what they are reading before acting
 * on it. `import` is the more dangerous of the two: its report ends in a command the
 * reader is invited to run.
 *
 * Apply this to every string that came out of a bundle. Do NOT apply it to values the
 * tool computed itself - counts, the locally-computed sha, literal labels, the temp
 * patch path we created, the validated local root - because those are trusted and
 * passing them through here only risks mangling legitimate output.
 *
 * Call it as `arr.map((s) => safe(s))`, NEVER as `arr.map(safe)`: map passes the index
 * as the second argument, so `max` becomes 0 for the first element and every string is
 * truncated to "…(truncated)".
 */
export function safe(s: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  return stripped.length > max ? stripped.slice(0, max) + "…(truncated)" : stripped;
}
