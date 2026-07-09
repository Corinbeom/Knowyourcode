const SENSITIVE_KEY_PATTERN = /(authorization|cookie|token|secret|api[_-]?key|password|answer|answers|raw[_-]?response|llm)/i;
const REDACTION = "[Filtered]";
const SENSITIVE_NAME_PATTERN =
  String.raw`(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH[_-]?SECRET)[A-Z0-9_]*)`;
const SECRET_VALUE_PATTERN = String.raw`(?:"[^"\n]*"|'[^'\n]*'|` + "`" + String.raw`[^` + "`" + String.raw`\n]*` + "`" + String.raw`|[A-Za-z0-9_./:@+=-]{3,})`;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g;
const AUTHORIZATION_VALUE_PATTERN = /\b(Bearer|Basic)\s+["']?[^"'\s]+["']?/gi;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`^(\s*[+\- ]?\s*[\{,]?\s*(?:export\s+)?(?:(?:const|let|var)\s+)?(?:[\w$.]+\.)?["']?${SENSITIVE_NAME_PATTERN}["']?(?:\s*:\s*[\w<>\[\]|., ?]+)?\s*[:=]\s*)${SECRET_VALUE_PATTERN}`,
  "gim"
);
const KNOWN_SECRET_VALUE_PATTERN =
  /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g;

type SentryEventLike = {
  request?: {
    cookies?: unknown;
    headers?: unknown;
    data?: unknown;
  };
  extra?: unknown;
  contexts?: unknown;
  breadcrumbs?: unknown[];
};

export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    event.request.headers = scrubRecord(event.request.headers);
    event.request.data = undefined;
  }

  event.extra = scrubRecord(event.extra);
  event.contexts = scrubRecord(event.contexts);

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => {
      if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
      const data = "data" in breadcrumb ? scrubRecord(breadcrumb.data) : undefined;
      return { ...breadcrumb, data };
    });
  }

  return event;
}

function scrubRecord<T>(value: T): T {
  if (typeof value === "string") return scrubString(value) as T;
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrubRecord(item)) as T;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTION : scrubRecord(item)
    ])
  ) as T;
}

function scrubString(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, REDACTION)
    .replace(AUTHORIZATION_VALUE_PATTERN, REDACTION)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTION}`)
    .replace(KNOWN_SECRET_VALUE_PATTERN, REDACTION);
}
