const REDACTION = "[REDACTED]";

const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".npmrc",
  ".pypirc",
  ".netrc"
]);

const SENSITIVE_FILE_PATTERNS = [
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)(credentials|service[-_]?account).*\.json$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /\.(pem|key|p12|pfx)$/i
];

const SENSITIVE_NAME_PATTERN =
  String.raw`(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH[_-]?SECRET)[A-Z0-9_]*)`;
const SECRET_VALUE_PATTERN = String.raw`(?:"[^"\n]*"|'[^'\n]*'|` + "`" + String.raw`[^` + "`" + String.raw`\n]*` + "`" + String.raw`|[A-Za-z0-9_./:@+=-]{3,})`;

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g;
const AUTHORIZATION_PATTERN = /\b(Authorization\s*[:=]\s*)(Bearer|Basic)\s+["']?[^"'\s]+["']?/gi;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`^(\s*[+\- ]?\s*[\{,]?\s*(?:export\s+)?(?:(?:const|let|var)\s+)?(?:[\w$.]+\.)?["']?${SENSITIVE_NAME_PATTERN}["']?(?:\s*:\s*[\w<>\[\]|., ?]+)?\s*[:=]\s*)${SECRET_VALUE_PATTERN}`,
  "gim"
);
const KNOWN_SECRET_VALUE_PATTERN =
  /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g;

export function isSensitiveFilePath(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? path;
  if (SENSITIVE_FILE_NAMES.has(fileName)) return true;
  if (/^\.env\.(?!example$).+/i.test(fileName)) return true;
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

export function redactSecrets(input: string): string {
  return input
    .replace(PRIVATE_KEY_PATTERN, REDACTION)
    .replace(AUTHORIZATION_PATTERN, `$1${REDACTION}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTION}`)
    .replace(KNOWN_SECRET_VALUE_PATTERN, REDACTION);
}
