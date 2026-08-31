# Demote commit-mismatch check from refusal to warning

## What changed

A commit mismatch on `csession import` no longer throws `SafetyError` (exit 2). It is
now reported as a `WARNING:` block in the report and the import proceeds normally. A
remote mismatch is unchanged: still a `SafetyError`, exit 2, bypassable with `--force`.

### `src/commands/import.ts`

- Removed the `else if (!force) { throw new SafetyError(...) }` branch for a commit
  mismatch. Replaced with `commitWarning = commitMismatchWarning(...)`, which is
  threaded into `buildReport` and printed near the top of the report (after the
  worktree-created block, before the session summary).
- `--worktree`'s own logic is untouched: it still short-circuits the mismatch handling,
  still throws `UserError` when the bundle's commit isn't present locally
  (`relation.kind === "unknown"`), still creates the worktree and imports there. `force`
  is no longer read anywhere in this code path (it never actually was, when
  `useWorktree` was true — the old `else if` meant force only ever mattered on the
  non-worktree branch, which is exactly the branch that no longer checks it).
- Replaced `mismatchAdvice()` (the three-way advice text: `--worktree` / `--force` /
  manual checkout, used only inside the removed `SafetyError`) with
  `commitMismatchWarning(bundleCommit, localCommit, relation)`. It keeps the
  relationship sentence from `describeRelation()` verbatim (e.g. "your checkout is 1
  commit ahead of the bundle (2 files differ)"), states plainly that the history
  describes the bundle's tree while Claude re-reads whatever's on disk, and mentions
  `--worktree` as a choice for the exact tree — but only when `relation.kind !==
  "unknown"`, since suggesting `--worktree` against a commit that hasn't been fetched
  would be advice that cannot work (this conditional mirrors reasoning already present
  in the removed `mismatchAdvice`'s doc comment, so I kept it rather than dropping the
  distinction).
- `buildReport` gained a `commitWarning: string | null` parameter, inserted into the
  report right after the worktree-created lines.
- **One change beyond the letter of the brief, disclosed here:** the pre-existing
  `if (force) { ... WARNING: --force was used ... }` line at the end of the report said
  "The history may describe a tree you do not have" — that sentence was about the
  commit-mismatch bypass `--force` used to perform. Since `--force` no longer touches
  the commit check at all, I reworded it to describe its new, sole meaning: "It only
  bypasses the remote-mismatch check now, so make sure this is the repository you think
  it is." No test asserted the old exact string (checked via grep before touching it).
  Flagging this because the brief only named the help text in `cli.ts` for this update,
  not this runtime string — I judged leaving factually wrong text next to a warning
  about `--force` worse than the small extra edit, but it's a judgment call, not
  something explicitly requested.

### `src/cli.ts`

- Added an explicit `--force` help line (previously `--force` had no description of its
  own, only `--worktree` did): "proceed past a remote mismatch ... Does not relate to a
  commit mismatch, which is reported but never refused."
- Reworded the `--worktree` help line: it's now framed as an opt-in choice ("so the tree
  matches exactly what the transcript describes... This is an opt-in choice, not a way
  past a refusal - a commit mismatch never refuses"), dropping the old framing
  ("instead of refusing").

### `docs/superpowers/specs/2026-08-31-csession-design.md`

- Refusals table: the `Local HEAD ≠ git.commit` row's Behaviour changed from "Report the
  gap, print the `git checkout` command, stop. `--force` proceeds anyway" to "Report the
  relationship ... as a warning, and continue. `--worktree` checks the bundle's commit
  out into a separate directory if you want the exact tree."
- Added the explanatory paragraph the brief asked for, directly under the table: a
  commit is not part of a session's identity (appears nowhere in the transcript or the
  `~/.claude/projects/...` path), Claude Code itself does not track it, so a mismatch is
  reported, not refused — while a remote mismatch means a possibly different repository,
  where every rewritten path would be nonsense, so it still stops.
- Updated the `--force` paragraph: "covers the remote mismatch above ... It has nothing
  to do with a commit mismatch, which is never refused in the first place" (was: "covers
  exactly the two git mismatches above").
- **Also updated, beyond the literal ask, disclosed here:** the "Honest limitation"
  section's closing sentence read "The commit check is the only guard, which is why it
  stops rather than warns" — a direct, now-false statement sitting in the same document
  I was told to bring into agreement with the code. I reworded it to say the commit
  check reports the gap because a difference of time isn't evidence of a wrong
  repository, and the remote check is the one that still stops. I judged this squarely
  inside "so the document and the code agree," but it's a second paragraph beyond the
  one table row named in the brief, so flagging it explicitly.
- **Left alone, noticed but not fixed:** the `Import` section's usage line still reads
  `csession import FILE [--root PATH] [--new-id] [--force]` with no `--worktree` —
  this omission predates my change (the flag was added by an earlier commit,
  `dd9cf1c`/`06c5576`, and the spec was never updated then either). Out of scope for
  this task; not touched.

## Tests — what changed and why (`src/commands/import.test.ts`)

Per the brief, rewrote tests to the new contract rather than deleting them or weakening
assertions. All rewrites keep or strengthen the original test's intent.

1. **`a commit mismatch refuses with exit 2 and writes nothing`** → **`a commit mismatch
   is reported as a warning and the import proceeds`**. Was: expects `caught()` exit 2,
   a `git ... checkout` command in the error, no file written. Now: `importCommand`
   returns normally; report matches `/WARNING: commit mismatch/` and `/fetch first/`
   (the relationship sentence for this test's unknown-commit case); transcript file
   exists.

2. **`--force proceeds past a commit mismatch`** → **`a commit mismatch imports without
   needing --force`**. This is the test named in the brief as "no longer meaningful for
   that flag." Reworked to *not* pass `--force` at all and still assert success, plus an
   explicit check that the unrelated "`--force` was used" warning does *not* appear
   (since it wasn't passed) — proving the flag plays no part in this path any more.

3. **New: `a commit mismatch still writes the transcript to the right place and rewrites
   paths`** (the brief's explicit "Add:" item). Uses the two-commit fixture so bundle
   and local commit genuinely differ; asserts the transcript lands at
   `sessionFilePath(r.root, SESSION_ID)`, its content has paths rewritten to `r.root`
   and no trace of `SENDER_ROOT`, and the report still says "3 paths rewritten" and
   contains the resume command — i.e., a commit mismatch changes nothing about what
   import actually does to the transcript.

4. **`commit mismatch message states how the two commits relate`** →
   **`commit mismatch warning states how the two commits relate`**. This test (and the
   two below) were not explicitly named in the brief, but they assert on the exact
   content of the now-removed `SafetyError` message (`mismatchAdvice`'s three-option,
   strictly-ordered layout: `--worktree` before `--force` before the manual `git -C ...
   checkout` line) — they fail outright once that code path stops existing, so per "That
   is expected — update them to the new contract rather than deleting them" they needed
   rework too. Rewrote to assert the same relationship sentence
   (`/ahead of the bundle/`, `/1 commit/`, `/2 files? differ/`) lands in the successful
   report instead of a thrown error, plus that the transcript is written.

5. **`commit mismatch message offers --worktree, best-first, when the commit is known
   locally`** → **`commit mismatch warning mentions --worktree when the commit is known
   locally`**. Dropped the ordering assertions (`--worktree` before `--force` before
   `git -C`) since that three-way ordered menu doesn't exist any more — there is no more
   `--force`-as-alternative or manual-checkout advice text for a commit mismatch at all.
   Kept the one part of the original intent that still applies: the warning surfaces
   `--worktree` as an option when it would actually work.

6. **`commit mismatch message does NOT offer --worktree when the bundle's commit is
   unknown locally`** → **`commit mismatch warning does NOT mention --worktree when the
   bundle's commit is unknown locally`**. Same rework as #5, minus the ordering check.
   Dropped the `assert.match(err.message, /--force/)` line — `--force` is no longer part
   of the commit-mismatch text at all (it wasn't passed in this test, so the generic
   "--force was used" report line doesn't fire either), so that assertion no longer
   corresponds to anything in the new contract. Kept `/fetch/i` (still true — describeRelation's
   "unknown" case says "fetch first").

**Untouched, as instructed:**
- `a remote mismatch refuses with exit 2` — unchanged, still passes unmodified.
- `--worktree does not bypass the remote mismatch check` — unchanged, still passes.
- `an existing session id refuses, and --new-id succeeds with a different id` —
  unrelated, unchanged.
- All seven `--worktree` tests (imports into new worktree / untouched checkout, fails on
  unknown commit, wins combined with `--force`, doesn't bypass remote check, doesn't
  bypass checksum check, refuses to reuse an existing path, still enforces id
  collision) — unchanged, all still pass unmodified. None of these needed rework: the
  `useWorktree` branch's own logic (UserError on unknown commit, worktree creation,
  path rewriting into the worktree) was not touched by this change.
- `src/e2e.test.ts` — still passes unmodified. It calls `importCommand(..., { force:
  true }, ...)` against two throwaway repos with genuinely different commits, with a
  comment "Commits differ ... so --force is expected here." That comment is now stale
  (force is no longer needed there) but the test still passes since passing an unneeded
  `force: true` is harmless. Not in the brief's list, doesn't fail, left alone —
  flagging the stale comment rather than silently editing an unlisted file.

## TDD evidence

Ran the full suite before touching any test, confirming the "old" tests exercised the
refusal path and would (correctly) fail once the `SafetyError` was removed — then made
the corresponding code change, then updated each failing test to the new contract, then
reran. Net result: two tests removed via rework became three (the brief's explicit
"Add:" item), and three "FEATURE 1" tests were reworked 1:1 — no tests deleted, none
weakened, one net test added.

## Test counts

- Before: **119 tests passing**, 0 failing. Verified directly: after finishing all
  edits I ran `git stash` to put the tree back to the untouched `main` state and reran
  `npm test`, which reported `tests 119 / pass 119 / fail 0`, then `git stash pop` to
  restore all four changed files (confirmed via `git status` afterward — nothing lost).
- After: **120 tests passing**, 0 failing (`tsc && node --test`, full suite, no
  skips). Net +1 matches the diff: one 2-test block was reworked into 3 tests (the
  brief's explicit "Add:" item), one 3-test block was reworked into 3 tests, no tests
  deleted.

## Files changed (with line counts from `git diff --stat`)

```
 docs/superpowers/specs/2026-08-31-csession-design.md | 26 +++++++++++++++++-----------
 src/cli.ts                                            | 15 ++++++++++-----
 src/commands/import.test.ts                           | 85 +++++++++++++++++++++++++++++++++++++++++---------------------------------
 src/commands/import.ts                                | 71 +++++++++++++++++++++++++++++++++++------------------------------------
 4 files changed, 115 insertions(+), 82 deletions(-)
```

## Concerns / things worth a second look

1. Two small edits beyond the literal task list, both disclosed above with reasoning:
   the `--force` runtime warning string in `import.ts`, and the "Honest limitation"
   paragraph in the spec. Neither was named explicitly in the brief; both directly
   contradicted the new behavior in a way that seemed worse to leave than to fix. Happy
   to revert either if that's not wanted.
2. The spec's `Import` usage line omitting `--worktree` entirely is a pre-existing gap
   (predates this task) — left untouched, noted above.
3. Nothing in the brief looked wrong to me; no STOP-and-report situation arose. The
   remote-mismatch tests all passed unmodified, confirming that check truly is
   independent of the commit-mismatch code path both before and after.
