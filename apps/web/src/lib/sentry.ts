import * as Sentry from "@sentry/nextjs";

type SentryMode = "project" | "commit";
type SentryProvider = "web-local" | "fastapi-proxy" | "github" | "llm" | "unknown";

type RouteErrorContext = {
  mode: SentryMode;
  route: string;
  provider?: SentryProvider;
  errorType?: string;
};

export function captureRouteError(error: unknown, context: RouteErrorContext): void {
  if (!isSentryEnabled()) return;

  Sentry.withScope((scope) => {
    scope.setTag("mode", context.mode);
    scope.setTag("route", context.route);
    scope.setTag("provider", context.provider ?? "unknown");
    scope.setTag("error_type", context.errorType ?? getErrorType(error));
    scope.setContext("kyc_route", {
      mode: context.mode,
      route: context.route,
      provider: context.provider ?? "unknown",
      error_type: context.errorType ?? getErrorType(error)
    });
    Sentry.captureException(toError(error));
  });
}

export function captureBackendResponseError(route: string, mode: SentryMode, status: number): void {
  if (!isSentryEnabled()) return;
  if (status < 500) return;

  Sentry.withScope((scope) => {
    scope.setTag("mode", mode);
    scope.setTag("route", route);
    scope.setTag("provider", "fastapi-proxy");
    scope.setTag("error_type", "backend_response_error");
    scope.setContext("kyc_route", {
      mode,
      route,
      provider: "fastapi-proxy",
      status
    });
    Sentry.captureMessage(`FastAPI proxy returned ${status}`, "error");
  });
}

function isSentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN);
}

function getErrorType(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "Unknown route error");
}
