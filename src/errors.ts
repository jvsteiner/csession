export class CsError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad arguments, missing file, unresolvable root. */
export class UserError extends CsError {
  constructor(message: string) {
    super(message, 1);
  }
}

/** A refusal: commit mismatch, remote mismatch, id collision. */
export class SafetyError extends CsError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** Bad sha, unreadable manifest, unknown schema. */
export class CorruptBundleError extends CsError {
  constructor(message: string) {
    super(message, 3);
  }
}
