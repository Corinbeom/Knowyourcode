const SENSITIVE_KEY_PATTERN = /(authorization|cookie|token|secret|api[_-]?key|password|answer|answers|raw[_-]?response|llm)/i;

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
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrubRecord(item)) as T;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[Filtered]" : scrubRecord(item)
    ])
  ) as T;
}
