import { test } from "node:test";
import assert from "node:assert/strict";
import { caught } from "./testutil.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundle, readBundle, atomicWrite } from "./bundle.js";
import { CorruptBundleError } from "./errors.js";

test("a bundle round-trips its files exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-bundle-"));
  try {
    const out = join(dir, "x.ccsession");
    writeBundle(out, { "manifest.json": '{"a":1}', "session.jsonl": '{"b":2}\n' });
    const got = readBundle(out);
    assert.equal(got["manifest.json"], '{"a":1}');
    assert.equal(got["session.jsonl"], '{"b":2}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bundle missing manifest.json is corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-bundle-"));
  try {
    const out = join(dir, "x.ccsession");
    writeBundle(out, { "session.jsonl": "{}\n" });
    const err = caught(() => readBundle(out));
    assert.equal(err.exitCode, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not a tar archive is corrupt, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-bundle-"));
  try {
    const out = join(dir, "x.ccsession");
    atomicWrite(out, "definitely not a tarball");
    const err = caught(() => readBundle(out));
    assert.equal(err.exitCode, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWrite leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-atomic-"));
  try {
    const dest = join(dir, "out.txt");
    atomicWrite(dest, "hello");
    assert.equal(readFileSync(dest, "utf8"), "hello");
    assert.deepEqual(readdirSync(dir), ["out.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWrite overwrites an existing file in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-atomic-"));
  try {
    const dest = join(dir, "out.txt");
    atomicWrite(dest, "first");
    atomicWrite(dest, "second");
    assert.equal(readFileSync(dest, "utf8"), "second");
    assert.ok(existsSync(dest));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bundle containing a directory entry is corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "csession-bundle-"));
  try {
    const staging = mkdtempSync(join(tmpdir(), "csession-stage-"));
    try {
      writeFileSync(join(staging, "manifest.json"), '{"a":1}');
      writeFileSync(join(staging, "session.jsonl"), "{}\n");
      mkdirSync(join(staging, "somedir"));
      const tarOut = join(dir, "x.ccsession");
      execFileSync("tar", ["-czf", tarOut, "-C", staging, "manifest.json", "session.jsonl", "somedir"]);
      const err = caught(() => readBundle(tarOut));
      assert.equal(err.exitCode, 3);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
