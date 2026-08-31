#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { CsError } from "./errors.js";
import { listCommand } from "./commands/list.js";
import { exportCommand } from "./commands/export.js";

const HELP = `csession - move a Claude Code session between machines

  csession list [--project PATH]              sessions for a project, newest first
  csession export [id] -o FILE [options]      build a bundle
  csession inspect FILE                       print manifest and reports
  csession import FILE [options]              receive a bundle

export options:  --dry-run  --include-untracked  --paranoid  --no-redact
import options:  --root PATH  --new-id  --force

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
  }
  throw e;
}
