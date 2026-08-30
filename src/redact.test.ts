import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.js";

function line(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

test("redacts a github token", () => {
  const { lines, hits } = redact([line("token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")], { paranoid: false });
  assert.ok(lines[0]!.includes("[REDACTED:github-token]"));
  assert.deepEqual(hits, [{ rule: "github-token", count: 1 }]);
});

test("redacts an anthropic key, an aws key id and a tavily key", () => {
  const src = [
    line("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    line("AKIAIOSFODNN7EXAMPLE"),
    line("tvly-dev-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
  ];
  const { hits } = redact(src, { paranoid: false });
  const names = hits.map((h) => h.rule).sort();
  assert.deepEqual(names, ["anthropic-key", "aws-access-key-id", "tavily-key"]);
});

test("redacts the password in a connection string", () => {
  const { lines } = redact([line("postgres://semanticd:hunter2@localhost:5432/db")], { paranoid: false });
  assert.ok(lines[0]!.includes("[REDACTED:connection-string-password]"));
  assert.ok(!lines[0]!.includes("hunter2"));
});

test("redacts a value assigned to a secret-shaped name", () => {
  const { lines } = redact([line("export MY_API_KEY=abcdefghijklmnopqrstuvwxyz012345")], { paranoid: false });
  assert.ok(lines[0]!.includes("[REDACTED:named-secret]"));
});

test("redacts a private key block", () => {
  const { lines } = redact([line("-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----")], { paranoid: false });
  assert.ok(lines[0]!.includes("[REDACTED:private-key]"));
});

test("PROPERTY: redacted output is still valid JSON, line for line", () => {
  const src = [
    // github-token
    line("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    // aws-access-key-id
    line('a "quoted" string with AKIAIOSFODNN7EXAMPLE inside'),
    // connection-string-password
    line("postgres://u:p@h/db"),
    // anthropic-key
    line("sk-ant-dev-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    // tavily-key
    line("tvly-dev-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    // openai-key
    line("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    // google-api-key
    line("AIzaSyDpvs9YZ6M2QF8bCH8Z0N9vN0K1Q2R3S4T5U"),
    // slack-token
    line("xoxb-1234567890123-1234567890123-ABCDEFGHIJKLMN"),
    // stripe-key
    line("sk_live_ABCDEFGHIJKLMNOPQRST"),
    // named-secret
    line("MY_TOKEN=abcdefghijklmnopqrstuvwxyz012345"),
    // private-key
    line("-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----"),
  ];
  const { lines } = redact(src, { paranoid: false });
  assert.equal(lines.length, src.length);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

test("CRITICAL: private-key pattern does not match across quotes", () => {
  // A line with BEGIN in one field and END in another field later.
  // The pattern must not span the intervening quotes.
  const src = [
    line('text with "-----BEGIN RSA PRIVATE KEY-----" and more stuff and "-----END RSA PRIVATE KEY-----" at end'),
  ];
  const { lines } = redact(src, { paranoid: false });
  // If the pattern incorrectly matched across quotes, this would fail to parse.
  assert.doesNotThrow(() => JSON.parse(lines[0]!));
  // The pattern should NOT match because the markers are in separate string fields.
  assert.ok(lines[0]!.includes("BEGIN RSA PRIVATE KEY"));
  assert.ok(lines[0]!.includes("END RSA PRIVATE KEY"));
});

test("no false positives on ordinary prose and code", () => {
  const src = [
    line("the function returns a boolean and the commit is 08a857880f977d13e68769083271a62465dfcf36"),
    line("import { readFileSync } from 'node:fs'"),
  ];
  const { hits } = redact(src, { paranoid: false });
  assert.deepEqual(hits, []);
});

test("paranoid mode catches a long high-entropy blob that default mode ignores", () => {
  const blob = line("value: Zx9Qw3Vb7Nm2Kd8Lp4Rt6Yu1Ic5Oa0Se3Hg7Jf9Dk2");
  assert.deepEqual(redact([blob], { paranoid: false }).hits, []);
  assert.equal(redact([blob], { paranoid: true }).hits[0]?.rule, "high-entropy");
});

test("paranoid mode does NOT flag 40-char hex commit SHA", () => {
  // The isLowEntropy check exempts hex-only strings (commit SHAs, checksums).
  const sha = line("commit 08a857880f977d13e68769083271a62465dfcf36 by author");
  const { hits } = redact([sha], { paranoid: true });
  assert.deepEqual(hits, []);
});

test("no false positives on near-miss named-secret", () => {
  const src = [
    // "token" mentioned but no assignment with a long value
    line("The token is useful for authentication"),
    // Assignment but value is too short
    line("API_KEY=abc123"),
  ];
  const { hits } = redact(src, { paranoid: false });
  assert.deepEqual(hits, []);
});

test("no false positives on near-miss connection-string", () => {
  const src = [
    // URL with no credentials
    line("postgres://localhost:5432/db"),
    // Malformed URL without password part
    line("postgres://user@localhost/db"),
  ];
  const { hits } = redact(src, { paranoid: false });
  assert.deepEqual(hits, []);
});
