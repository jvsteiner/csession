#!/usr/bin/env bash
# ============================================================================
# csession demo — a real export -> inspect -> import round trip.
#
# Called by `make demo`. Everything happens in a throwaway sandbox; the only
# thing touched outside it is the session folder csession itself writes, and
# this script removes both of those on the way out.
#
# Args: $1 sandbox dir   $2 path to dist/cli.js   $3 session store dir
# ============================================================================
set -euo pipefail

SANDBOX="$1"
CLI="$2"
SESSIONS_DIR="$3"

SENDER="$SANDBOX/sender"
RECEIVER="$SANDBOX/receiver"
BUNDLES="$SANDBOX/bundles"          # outside both repos, so neither goes dirty
SESSION_ID="0d3e0000-0000-4000-8000-000000000001"

# Encoded project-dir name: the working directory with every "/" turned into "-".
encode() { printf '%s' "$1" | tr '/' '-'; }

cleanup() {
  local sender_enc receiver_enc
  sender_enc=$(encode "$SENDER_ROOT" 2>/dev/null || true)
  receiver_enc=$(encode "$RECEIVER_ROOT" 2>/dev/null || true)
  [ -n "${sender_enc:-}" ]   && rm -rf "$SESSIONS_DIR/$sender_enc"
  [ -n "${receiver_enc:-}" ] && rm -rf "$SESSIONS_DIR/$receiver_enc"
  return 0
}
trap cleanup EXIT

rule() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

rm -rf "$SANDBOX"
mkdir -p "$SENDER" "$BUNDLES"

rule "1. a sender repo with one commit and an uncommitted edit"
git -C "$SENDER" init -q -b main
git -C "$SENDER" config user.email demo@example.com
git -C "$SENDER" config user.name  "csession demo"
git -C "$SENDER" remote add origin git@github.com:example/demo.git
printf 'export const answer = 41;\n' > "$SENDER/app.ts"
printf '.env\n' > "$SENDER/.gitignore"
git -C "$SENDER" add -A
git -C "$SENDER" commit -q -m "initial"
# macOS: /var is a symlink to /private/var, and csession resolves roots through
# git. Key everything off git's answer or the session folder will not be found.
SENDER_ROOT=$(git -C "$SENDER" rev-parse --show-toplevel)
printf 'export const answer = 42;\n' > "$SENDER_ROOT/app.ts"          # tracked edit
printf 'AWS_SECRET_ACCESS_KEY=REAL_SECRET_DO_NOT_SHIP\n' > "$SENDER_ROOT/.env"  # ignored
git -C "$SENDER_ROOT" --no-pager log --oneline -1 | sed 's/^/   /'
git -C "$SENDER_ROOT" status --short | sed 's/^/   /'

rule "2. a receiver: a clone, so it sits on the same commit"
git clone -q "$SENDER_ROOT" "$RECEIVER"
RECEIVER_ROOT=$(git -C "$RECEIVER" rev-parse --show-toplevel)
git -C "$RECEIVER_ROOT" remote set-url origin git@github.com:example/demo.git
echo "   $RECEIVER_ROOT"

rule "3. a synthetic transcript, carrying a secret and a sender path"
SDIR="$SESSIONS_DIR/$(encode "$SENDER_ROOT")"
mkdir -p "$SDIR"
{
  printf '{"type":"user","cwd":"%s","version":"2.1.251","sessionId":"%s"}\n' "$SENDER_ROOT" "$SESSION_ID"
  printf '{"type":"assistant","cwd":"%s","sessionId":"%s","message":{"content":[{"type":"text","text":"edited %s/app.ts with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and read /Users/someone-else/notes.md"}]}}\n' \
    "$SENDER_ROOT" "$SESSION_ID" "$SENDER_ROOT"
} > "$SDIR/$SESSION_ID.jsonl"
echo "   $SDIR/$SESSION_ID.jsonl  ($(wc -l < "$SDIR/$SESSION_ID.jsonl" | tr -d ' ') records)"

rule "4. export — watch the redaction report"
BUNDLE="$BUNDLES/demo.ccsession"
( cd "$SENDER_ROOT" && node "$CLI" export "$SESSION_ID" -o "$BUNDLE" ) | sed 's/^/   /'

rule "5. inspect — look before you send"
node "$CLI" inspect "$BUNDLE" | sed 's/^/   /'

rule "6. proof: what did and did not travel"
if grep -q 'REAL_SECRET_DO_NOT_SHIP' "$BUNDLE" 2>/dev/null; then
  echo "   FAIL: the ignored .env secret is in the bundle"; exit 1
else
  echo "   .env secret (gitignored)      absent from the bundle   ok"
fi
if tar -xzOf "$BUNDLE" session.jsonl | grep -q 'ghp_ABCDEF'; then
  echo "   FAIL: the API key survived redaction"; exit 1
else
  echo "   API key in the transcript     redacted                 ok"
fi
tar -xzOf "$BUNDLE" session.jsonl | grep -q 'REDACTED:github-token' \
  && echo "   redaction marker              present                 ok"

rule "7. import into the receiver — the tree must not move"
BEFORE=$(git -C "$RECEIVER_ROOT" status --porcelain)
node "$CLI" import "$BUNDLE" --root "$RECEIVER_ROOT" | sed 's/^/   /'
AFTER=$(git -C "$RECEIVER_ROOT" status --porcelain)
[ "$BEFORE" = "$AFTER" ] \
  && echo "   receiver working tree         untouched               ok" \
  || { echo "   FAIL: the receiver's working tree changed"; exit 1; }

rule "8. the imported transcript now points at the receiver"
IMPORTED="$SESSIONS_DIR/$(encode "$RECEIVER_ROOT")/$SESSION_ID.jsonl"
grep -q "$RECEIVER_ROOT" "$IMPORTED" && echo "   receiver root                 rewritten in place      ok"
grep -q "$SENDER_ROOT"   "$IMPORTED" && { echo "   FAIL: a sender path survived"; exit 1; } \
  || echo "   sender root                   gone                    ok"
grep -q '/Users/someone-else/notes.md' "$IMPORTED" \
  && echo "   unrelated foreign path        left alone, as designed ok"

rule "done"
echo "   sandbox:  $SANDBOX   (make demo-clean to remove)"
echo "   the two session folders this created have been removed."
