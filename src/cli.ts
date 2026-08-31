#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { CsError } from "./errors.js";
import { listCommand } from "./commands/list.js";
import { exportCommand } from "./commands/export.js";
import { inspectCommand } from "./commands/inspect.js";
import { importCommand } from "./commands/import.js";

const HELP = `csession - move a Claude Code session between machines

  csession list [--project PATH]              sessions for a project, newest first
  csession export [id] -o FILE [options]      build a bundle
  csession inspect FILE                       print manifest and reports
  csession import FILE [options]              receive a bundle

export options:  --dry-run  --include-untracked  --paranoid  --no-redact
import options:  --root PATH  --new-id  --force  --worktree

  --force      proceed past a remote mismatch (this may be a different
               repository). Does not relate to a commit mismatch, which is
               reported but never refused - see --worktree below.
  --worktree   check the bundle's commit out into a new git worktree and
               import there instead of into the current checkout, so the
               tree matches exactly what the transcript describes. The
               current checkout is left untouched. This is an opt-in choice,
               not a way past a refusal - a commit mismatch never refuses.
               Still refuses on any OTHER mismatch (remote, schema, id
               collision). Wins over --force if both are given.

exit codes: 0 ok, 1 user error, 2 safety refusal, 3 corrupt bundle`;

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "list":
      console.log(listCommand(args.flags, process.cwd()));
      return 0;
    case "export":
      console.log(exportCommand(args.positional, args.flags, process.cwd(), new Date()));
      return 0;
    case "inspect":
      console.log(inspectCommand(args.positional));
      return 0;
    case "import":
      console.log(importCommand(args.positional, args.flags, process.cwd()));
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${args.command}\n\n${HELP}`);
      return 1;
  }
}

try {
  process.exit(main());
} catch (e) {
  if (e instanceof CsError) {
    console.error(`error: ${e.message}`);
    process.exit(e.exitCode);
  } else {
    // An untyped error is still a user-facing failure, and a stack trace is never the
    // right thing to show someone for one. transcript.ts, git.ts and bundle.ts all throw
    // plain Errors - several are genuine programmer-error guards that must stay loud in
    // tests, so they are not being converted; this net is what keeps them from reaching
    // a person as a wall of Node internals. Exit 1: an untyped failure is not a safety
    // refusal (2) and not a diagnosed corrupt bundle (3).
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
