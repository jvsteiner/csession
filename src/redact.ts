export interface RedactionHit {
  rule: string;
  count: number;
}

interface Rule {
  name: string;
  /**
   * Must never match a `"` or a `\`. Every replacement is inserted into a
   * JSON string literal verbatim, so a pattern that can span a quote would
   * produce a broken transcript.
   */
  pattern: RegExp;
  /** When set, only this capture group is replaced (the rest is kept). */
  group?: number;
}

const RULES: Rule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
  { name: "tavily-key", pattern: /tvly-[A-Za-z0-9_\-]{20,}/g },
  { name: "openai-key", pattern: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z\-]{10,}/g },
  { name: "stripe-key", pattern: /\b[sr]k_live_[0-9A-Za-z]{16,}/g },
  // Only the password group is replaced, so the host stays readable.
  { name: "connection-string-password", pattern: /([a-z][a-z0-9+.\-]*:\/\/[^\s:@"\\]+:)([^\s@"\\]+)(@)/g, group: 2 },
  { name: "named-secret", pattern: /((?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z_]*\s*[=:]\s*)([A-Za-z0-9_\-+/.]{16,})/g, group: 2 },
];

const PARANOID: Rule[] = [
  { name: "high-entropy", pattern: /\b[A-Za-z0-9+/_\-]{40,}\b/g },
];

function isLowEntropy(s: string): boolean {
  // Hex-only strings are almost always commit SHAs or checksums, not secrets.
  return /^[0-9a-f]+$/i.test(s);
}

export function redact(lines: string[], opts: { paranoid: boolean }): { lines: string[]; hits: RedactionHit[] } {
  const rules = opts.paranoid ? [...RULES, ...PARANOID] : RULES;
  const counts = new Map<string, number>();

  const out = lines.map((line) => {
    let current = line;
    for (const rule of rules) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      current = current.replace(re, (...args) => {
        const groups = args.slice(0, -2) as string[];
        const whole = groups[0]!;
        if (rule.name === "high-entropy" && isLowEntropy(whole)) return whole;
        counts.set(rule.name, (counts.get(rule.name) ?? 0) + 1);
        const token = `[REDACTED:${rule.name}]`;
        if (rule.group === undefined) return token;
        return groups
          .slice(1)
          .map((g, i) => (i + 1 === rule.group ? token : (g ?? "")))
          .join("");
      });
    }
    return current;
  });

  const hits = [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => a.rule.localeCompare(b.rule));

  return { lines: out, hits };
}
