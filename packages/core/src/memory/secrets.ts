export * as MemorySecrets from "./secrets"

/**
 * Deterministic credential scanning.
 *
 * Persistent memory amplifies any leak: a secret written today is replayed into
 * prompts months later. The model is explicitly NOT trusted to redact, so every
 * write path runs this scan first and fails closed.
 */

interface Rule {
  readonly name: string
  readonly pattern: RegExp
}

const RULES: ReadonlyArray<Rule> = [
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: "aws-secret-access-key", pattern: /aws(.{0,20})?(secret|private)(.{0,20})?['"][0-9a-zA-Z/+]{40}['"]/i },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/ },
  { name: "github-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/ },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "google-oauth-id", pattern: /\b[0-9]+-[0-9a-z_]{32}\.apps\.googleusercontent\.com\b/ },
  { name: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{20,}\b/ },
  { name: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "bearer-header", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/ },
  { name: "basic-auth-url", pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{6,}@/ },
  { name: "key-assignment", pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/i },
  { name: "env-dump", pattern: /(?:^|\n)\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION)[A-Z0-9_]*=/ },
  { name: "connection-string", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@/i },
]

export interface Scan {
  readonly clean: boolean
  readonly findings: ReadonlyArray<string>
}

export function scan(text: string): Scan {
  const findings = new Set<string>()
  for (const rule of RULES) {
    if (rule.pattern.test(text)) findings.add(rule.name)
  }
  return { clean: findings.size === 0, findings: [...findings] }
}

/** Best-effort redaction for rendering. Writes should reject rather than rely on this. */
export function redact(text: string): string {
  let out = text
  for (const rule of RULES) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`
    out = out.replace(new RegExp(rule.pattern.source, flags), `[redacted:${rule.name}]`)
  }
  return out
}
