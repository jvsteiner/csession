import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeProjectDir, sessionFilePath, claudeProjectsDir } from "./paths.js";
import { homedir } from "node:os";

test("encodeProjectDir replaces every slash with a dash", () => {
  assert.equal(encodeProjectDir("/Users/jamie/Code/semanticd"), "-Users-jamie-Code-semanticd");
});

test("encodeProjectDir is lossy for paths containing dashes - documented, not fixed", () => {
  // Both of these encode identically. This is why export derives the project
  // root from the transcript's cwd field rather than from the folder name.
  assert.equal(encodeProjectDir("/Users/jamie/Code/my-app"), "-Users-jamie-Code-my-app");
  assert.equal(encodeProjectDir("/Users/jamie/Code/my/app"), "-Users-jamie-Code-my-app");
});

test("encodeProjectDir strips a trailing slash", () => {
  assert.equal(encodeProjectDir("/Users/jamie/Code/x/"), "-Users-jamie-Code-x");
});

test("claudeProjectsDir sits under the home directory", () => {
  assert.equal(claudeProjectsDir(), `${homedir()}/.claude/projects`);
});

test("sessionFilePath composes dir, id and extension", () => {
  const p = sessionFilePath("/Users/jamie/Code/semanticd", "abc-123");
  assert.equal(p, `${homedir()}/.claude/projects/-Users-jamie-Code-semanticd/abc-123.jsonl`);
});
