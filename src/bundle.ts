import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { CorruptBundleError } from "./errors.js";

/** Write via a sibling temp file then rename, so a failure never leaves a partial artefact. */
export function atomicWrite(dest: string, data: string | Buffer): void {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(dest)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A gzipped tar of exactly the named files, flat, no directory entries. */
export function writeBundle(outPath: string, files: Record<string, string>): void {
  const staging = mkdtempSync(join(tmpdir(), "csession-stage-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(staging, name), content);
    }
    const tarOut = join(staging, ".bundle.tgz");
    const names = Object.keys(files);
    const r = spawnSync("tar", ["-czf", tarOut, "-C", staging, ...names], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`tar failed: ${r.stderr ?? ""}`);
    }
    atomicWrite(outPath, readFileSync(tarOut));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function readBundle(bundlePath: string): Record<string, string> {
  const staging = mkdtempSync(join(tmpdir(), "csession-unstage-"));
  try {
    const r = spawnSync("tar", ["-xzf", bundlePath, "-C", staging], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new CorruptBundleError(`not a readable .ccsession bundle: ${(r.stderr ?? "").trim()}`);
    }
    const out: Record<string, string> = {};
    for (const name of readdirSync(staging)) {
      out[name] = readFileSync(join(staging, name), "utf8");
    }
    if (!("manifest.json" in out)) {
      throw new CorruptBundleError("bundle contains no manifest.json");
    }
    if (!("session.jsonl" in out)) {
      throw new CorruptBundleError("bundle contains no session.jsonl");
    }
    return out;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
