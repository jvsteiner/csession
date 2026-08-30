import { listSessionFiles } from "../paths.js";
import { resolveProjectRoot } from "../args.js";

export function listCommand(flags: Record<string, string | boolean>, cwd: string): string {
  const explicit = typeof flags["project"] === "string" ? (flags["project"] as string) : undefined;
  const root = explicit ?? resolveProjectRoot(cwd);
  const sessions = listSessionFiles(root);
  if (sessions.length === 0) {
    return `No sessions found for ${root}`;
  }
  const rows = sessions.map((s) => {
    const when = new Date(s.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
    const kb = `${Math.round(s.bytes / 1024)}K`.padStart(7);
    return `  ${s.id}  ${when}  ${kb}`;
  });
  return [`Sessions for ${root} (newest first):`, ...rows].join("\n");
}
