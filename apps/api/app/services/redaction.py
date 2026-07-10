import re

REDACTION = "[REDACTED]"

SENSITIVE_FILE_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".npmrc",
    ".pypirc",
    ".netrc",
}

SENSITIVE_FILE_PATTERNS = (
    re.compile(r"(^|/)id_(rsa|dsa|ecdsa|ed25519)$", re.I),
    re.compile(r"(^|/)(credentials|service[-_]?account).*\.json$", re.I),
    re.compile(r"(^|/)\.aws/credentials$", re.I),
    re.compile(r"(^|/)\.docker/config\.json$", re.I),
    re.compile(r"\.(pem|key|p12|pfx)$", re.I),
)

SENSITIVE_NAME_PATTERN = (
    r"(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|"
    r"CLIENT[_-]?SECRET|AUTH[_-]?SECRET)[A-Z0-9_]*)"
)
SECRET_VALUE_PATTERN = r"(?:\"[^\"\n]*\"|'[^'\n]*'|`[^`\n]*`|[A-Za-z0-9_./:@+=-]{3,}(?=\s*(?:[,}\]]|$|#|//)))"

PRIVATE_KEY_PATTERN = re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----")
AUTHORIZATION_PATTERN = re.compile(r"\b(Authorization\s*[:=]\s*)(Bearer|Basic)\s+[\"']?[^\"'\s]+[\"']?", re.I)
SECRET_ASSIGNMENT_PATTERN = re.compile(
    rf"^(\s*[+\- ]?\s*[\{{,]?\s*(?:export\s+)?(?:(?:const|let|var)\s+)?(?:[\w$.]+\.)?[\"']?{SENSITIVE_NAME_PATTERN}[\"']?(?:\s*:\s*[\w<>\[\]|., ?]+)?\s*[:=]\s*){SECRET_VALUE_PATTERN}",
    re.I | re.M,
)
KNOWN_SECRET_VALUE_PATTERN = re.compile(
    r"\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|"
    r"AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b"
)


def is_sensitive_file_path(path: str) -> bool:
    file_name = path.rsplit("/", 1)[-1]
    if file_name in SENSITIVE_FILE_NAMES:
        return True
    if re.match(r"^\.env\.(?!example$).+", file_name, re.I):
        return True
    return any(pattern.search(path) for pattern in SENSITIVE_FILE_PATTERNS)


def redact_secrets(value: str) -> str:
    redacted = PRIVATE_KEY_PATTERN.sub(REDACTION, value)
    redacted = AUTHORIZATION_PATTERN.sub(r"\1" + REDACTION, redacted)
    redacted = SECRET_ASSIGNMENT_PATTERN.sub(r"\1" + REDACTION, redacted)
    return KNOWN_SECRET_VALUE_PATTERN.sub(REDACTION, redacted)
