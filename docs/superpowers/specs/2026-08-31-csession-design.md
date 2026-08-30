# csession — portable Claude Code session transfer

Date: 2026-08-31
Status: approved design, not yet implemented

## Problem

A Claude Code session lives only on the machine that created it. There is no
supported way to move one. Two situations need it:

1. **Machine to machine.** Work starts on a laptop and should continue on a
   build server (or the reverse).
2. **Person to person.** A peer picks up work in progress and needs the actual
   thread, not a summary.

Sessions are stored as JSONL at:

```
~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>.jsonl
```

Every record carries machine-specific state. A representative record:

```
cwd       = "/Users/jamie/Code/marketer"
version   = "2.1.246"
gitBranch = "main"
sessionId = "8ff16742-c6d9-4c69-8e1c-5b77f257456a"
```

Copying the file to another machine is not enough. Three things break:

- **Paths.** In one measured file, 38 of 47 records contained `/Users/jamie`.
  On a Linux host the same repo is at `/home/jamie`.
- **Workspace.** The conversation asserts things about files at a specific
  commit. A receiver on a different commit gets confidently wrong history.
- **Secrets.** A transcript contains every secret ever typed, printed or
  echoed into it. This was demonstrated live: two API keys were leaked into a
  session transcript by an over-eager verification command.

## Goals

- Move a full-fidelity session between machines and between people.
- Fail loudly rather than mislead.
- Never mutate the receiver's working tree.
- Never leak a secret by default.

## Non-goals

- Syncing all sessions. Wholesale copying is explicitly rejected — the local
  store measured 1.9 GB across 55 project folders.
- Moving credentials, `~/.claude.json`, or MCP configuration. Not session state.
- Shipping the repository. The receiver supplies that.
- Owning transport. See "Decisions".

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Fidelity | Full transcript | A peer must be able to read the actual exchange, not a summary. |
| Workspace | Transcript + git pointers | "Exactly pick up" requires the tree the conversation assumes. Pointers, not the repo, keep bundles small. |
| Secrets | Redact by default | Peer sharing is a stated use case. `--no-redact` exists but must be typed. |
| Transport | Plain file | Dumbest pipe. Works with scp, AirDrop, Slack, a git drop board. New channels need no code. |
| Form | Standalone CLI | You often export a session you are not in, and import before starting Claude. Both need to work outside a session. |
| Paths | Rewrite project root only | Only that prefix provably maps across machines. Rewriting every home path turns accurate history into confident fiction. |
| Transcript handling | Opaque | The session format is undocumented and version-stamped per record. Assume as little as possible so version drift does not break the tool. |

### Rejected alternatives

- **Transcript-aware structural transform.** Parse each record by type and
  rewrite only known path fields. More precise, but welds the tool to
  Anthropic's internal format, which changes on their schedule.
- **Git-native bundles.** Bundle as a commit in a side repo or the multisphere
  a2a drop board. This is a *transport*, not a format — and since the bundle is
  a plain file it can be dropped into a2a later with no code change. Deferred,
  not lost.

## Bundle format

One gzipped tar, named `<slug>.ccsession`. Plain tar so it can always be opened
by hand before sending.

```
manifest.json
session.jsonl
uncommitted.patch      (present only when git.dirty is true)
```

### manifest.json

```jsonc
{
  "schema": 1,
  "createdAt": "2026-08-31T09:14:22Z",
  "session": {
    "id": "8ff16742-c6d9-4c69-8e1c-5b77f257456a",
    "projectRoot": "/Users/jamie/Code/semanticd",  // the ONLY rewritable prefix
    "recordCount": 412,
    "sha256": "…",                                  // of session.jsonl as shipped
    "claudeVersions": ["2.1.246", "2.1.251"]        // every version seen
  },
  "git": {
    "remote": "git@github.com:unicitynetwork/semanticd.git",
    "branch": "main",
    "commit": "08a857880f977d13e68769083271a62465dfcf36",
    "dirty": true,
    "untrackedFiles": ["src/newthing.rs"]           // NAMES ONLY, never contents
  },
  "redaction": {
    "applied": true,
    "paranoid": false,
    "hits": [ { "rule": "github-token", "count": 2 } ]  // COUNTS ONLY
  }
}
```

Two fields are deliberately name-or-count only. `redaction.hits` must never
carry matched values — a redaction report that quotes what it redacted is a
leak wearing a hat. `git.untrackedFiles` carries names so the receiver knows
what is missing, never contents.

The manifest is the entire contract. Import reads only the manifest to decide
what it can and cannot do. It never infers behaviour from the transcript.

## Export

```
csession export [session-id] -o FILE [--dry-run] [--include-untracked]
                                    [--paranoid] [--no-redact]
```

With no id, list this project's sessions newest-first and prompt.

1. **Locate** `~/.claude/projects/<encoded>/<id>.jsonl`.
2. **Determine the project root** by reading the `cwd` field from the records —
   **not** from the folder name. The folder name is lossy: `-Users-jamie-Code-my-app`
   could mean `/Users/jamie/Code/my-app` or `/Users/jamie/Code/my/app`. If
   records disagree, take the most common value and warn.
3. **Probe git** in that root for remote, branch, commit, dirty state.
   When dirty, `git diff --binary HEAD` becomes `uncommitted.patch`.
   `--binary` so patches touching binaries still apply. Warn when the patch is large.
4. **Redact**, one pass, line by line. Output must remain valid JSON per line.
5. **Write** to a temp file, then atomically rename. Print the report.

### What the patch covers

`git diff HEAD` covers every file git already knows about, in any state.

| File state | In the patch |
|---|---|
| Tracked, unchanged | No — the commit SHA covers it |
| Tracked, edited, unstaged | Yes |
| Tracked, edited, staged | Yes |
| Tracked, deleted | Yes |
| New file that was `git add`ed | Yes — `add` makes it tracked |
| New file, never added | No |
| Ignored by `.gitignore` | No |

Rules:

- **Ignored files are never included.** No flag. This is where `.env` and dumped
  credentials live — the same instinct as redaction, applied to the filesystem.
- **Untracked-but-not-ignored files are excluded by default**, with
  `--include-untracked` to opt in.
- **Either way their names go in the manifest**, so the receiver sees
  "3 files referenced in this session are not in the bundle" rather than
  silently missing them.

### Redaction rules

| Kind | Patterns |
|---|---|
| Known key shapes | `sk-ant-`, `tvly-`, `AKIA`, `ghp_`/`gho_`/`ghs_`, `AIza`, `xox[bapsr]-`, `sk_live_`/`rk_live_` |
| Private keys | `-----BEGIN … PRIVATE KEY-----` blocks |
| Connection strings | `scheme://user:password@host` |
| Named assignments | values assigned to names matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD` |
| High entropy | opt-in via `--paranoid` only |

Replacement text is `[REDACTED:<rule-name>]` — safe inside a JSON string, and it
tells a reader what was there without telling them what it was.

`--paranoid` is not the default because entropy heuristics catch more and mangle
more. `--no-redact` exists for same-owner transfers and must be typed explicitly.

**Redaction is best-effort and will miss things** — a secret split across lines,
base64-encoded, or oddly shaped will get through. The tool must state this in its
own output, not only in the README. `--dry-run` prints the full report without
writing a bundle, and should be the habitual first step.

## Import

```
csession import FILE [--root PATH] [--new-id] [--force]
```

1. **Check `schema`.** Unknown version refuses with a clear message.
2. **Verify `sha256`.** A corrupt bundle stops here.
3. **Resolve the local root.** `--root` wins. Otherwise find a checkout whose
   `git remote` matches the manifest. If neither resolves, stop and ask —
   never guess.
4. **Run the safety checks** (below).
5. **Rewrite the one prefix**: manifest `projectRoot` → local root. Count swaps.
6. **Write** to `~/.claude/projects/<encoded-local-root>/<session-id>.jsonl`,
   temp file then atomic rename.
7. **Print the resume command**: `cd <root> && claude --resume <id>`.

### Refusals

Import never mutates the working tree.

| Situation | Behaviour |
|---|---|
| Local HEAD ≠ `git.commit` | Report the gap, print the `git checkout` command, stop. `--force` proceeds anyway |
| `uncommitted.patch` present | Run `git apply --check`, report, print the command, do not apply |
| Local remote ≠ `git.remote` | Warn loudly, stop. `--force` proceeds anyway |
| Session id already exists locally | Refuse; `--new-id` mints a fresh UUID |

A tool that helpfully checks out a branch is a tool that eventually destroys
someone's uncommitted work. Report and hand over the command.

`--force` covers exactly the two git mismatches above. It never bypasses the
sha check, the schema check, or an id collision — those indicate a broken or
ambiguous bundle rather than a judgement call.

`--new-id` rewrites the `sessionId` field throughout and renames the output file.
The default is to keep the original id, so the same session is traceable across
machines.

### Path rewriting and the unresolved report

Only the recorded `projectRoot` prefix is rewritten. Everything else is left
exactly as it was, and reported:

```
14 paths rewritten to /home/jamie/Code/semanticd
3 paths left as-is (not under the project root):
  /Users/jamie/.claude/plugins/...
  /Users/jamie/Documents/notes.md
```

The receiver then knows precisely where the history refers to a machine that is
not theirs.

### Honest limitation

Import verifies nothing about file contents. A resumed session carries history
that *asserts* things about a tree. If the tree differs, the model will be
confidently wrong. The commit check is the only guard, which is why it stops
rather than warns.

## CLI surface

```
csession list [--project PATH]   sessions for a project, newest first
                                 (defaults to the git root of the current directory)
csession export [id] -o FILE     build a bundle
csession import FILE             receive one
csession inspect FILE            print manifest and reports, extract nothing
```

`inspect` earns its place twice: look before sending, and look before importing.

## Implementation

TypeScript on Node, zero runtime dependencies.

Node is present on every machine that runs Claude Code, because Claude Code
ships through npm. No new toolchain on any box, including a peer's. `git` and
`tar` are shelled out to; both exist on macOS and Linux and neither is worth
reimplementing.

Rust was considered and rejected: a single binary is nice, but it means building
and shipping per-platform artefacts for a tool that reads JSON and calls git.

### Errors and exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | User error (bad arguments, missing file, unresolvable root) |
| 2 | Refused on safety (commit mismatch, id collision, remote mismatch) |
| 3 | Corrupt bundle (sha mismatch, unreadable manifest, unknown schema) |

Every failure prints what is known and what to do next. Bundles and imported
transcripts are written to a temp file and atomically renamed, so a failed run
never leaves a half-written artefact.

## Testing

Test-driven, against synthetic fixture transcripts covering the record shapes
observed in real files: `queue-operation`, `user`, `assistant`, and tool calls.

**The load-bearing test is a property**, not an example: after redaction and
rewriting, every line still parses as JSON and the record count is unchanged.
Run it across every fixture and every flag combination.

This matters more than redaction coverage. A missed secret is a known,
communicated risk. A transcript Claude Code can no longer load is a silent
failure discovered only when somebody tries to resume and gets nothing.

Remaining cases:

- One test per redaction rule, plus a no-false-positive corpus.
- Round-trip: export, import into a different root, assert the prefix swapped,
  the count is right, and the sha verified.
- One test per refusal: wrong commit, id collision, bad sha, unknown schema,
  remote mismatch.
- Project-root derivation: records that disagree, and a path containing a dash.
- Patch construction across each row of the file-state table.

## Deferred to phase 2

- `csession send <id> <ssh-host>` — export, scp, remote import in one step.
  The file has to work first.
- Publishing bundles into the multisphere a2a drop board.
- A thin slash-command skill wrapping the CLI for in-session use.

## Open risks

- **Format drift.** The session JSONL format is undocumented. `schema` and
  `claudeVersions` let the tool refuse or warn, but a large enough change breaks
  import. Mitigated by treating the transcript as opaque lines.
- **Redaction gaps.** Best-effort by nature. Mitigated by `--dry-run`,
  `inspect`, and stating the limitation in the tool's own output.
- **Wrong-tree resumes.** A receiver can `--force` past the commit check and get
  a confidently wrong session. Accepted: the alternative is a tool that mutates
  their tree.
