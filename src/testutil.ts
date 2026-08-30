/**
 * Runs `fn` and returns the error it threw.
 *
 * `assert.throws()` returns undefined, so `const err = assert.throws(...)` yields
 * nothing and any assertion on `err.exitCode` fails with a confusing TypeError.
 * This exists so tests can assert on an error's exit code, which is part of the
 * CLI's contract.
 */
export function caught(fn: () => unknown): Error & { exitCode?: number } {
  try {
    fn();
  } catch (e) {
    return e as Error & { exitCode?: number };
  }
  throw new Error("expected the call to throw, but it returned normally");
}
