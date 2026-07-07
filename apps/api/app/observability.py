import os
from collections.abc import Mapping
from typing import Any

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

SENSITIVE_KEYWORDS = (
    "authorization",
    "cookie",
    "token",
    "secret",
    "api_key",
    "apikey",
    "password",
    "answer",
    "answers",
    "raw_response",
    "llm",
)


def init_sentry() -> None:
    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return

    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("SENTRY_ENVIRONMENT") or os.getenv("API_ENV") or "development",
        integrations=[
            StarletteIntegration(transaction_style="endpoint"),
            FastApiIntegration(transaction_style="endpoint"),
        ],
        default_integrations=False,
        send_default_pii=False,
        traces_sample_rate=0.0,
        profiles_sample_rate=0.0,
        before_send=scrub_sentry_event,
    )


def set_api_sentry_context(*, mode: str, route: str, provider: str = "api") -> None:
    if not is_sentry_enabled():
        return

    sentry_sdk.set_tag("mode", mode)
    sentry_sdk.set_tag("route", route)
    sentry_sdk.set_tag("provider", provider)
    sentry_sdk.set_context(
        "kyc_route",
        {
            "mode": mode,
            "route": route,
            "provider": provider,
        },
    )


def capture_api_error(error: Exception, *, mode: str, route: str, provider: str = "api", error_type: str | None = None) -> None:
    if not is_sentry_enabled():
        return

    with sentry_sdk.new_scope() as scope:
        scope.set_tag("mode", mode)
        scope.set_tag("route", route)
        scope.set_tag("provider", provider)
        scope.set_tag("error_type", error_type or error.__class__.__name__)
        scope.set_context(
            "kyc_route",
            {
                "mode": mode,
                "route": route,
                "provider": provider,
                "error_type": error_type or error.__class__.__name__,
            },
        )
        sentry_sdk.capture_exception(error)


def scrub_sentry_event(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any]:
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("cookies", None)
        request.pop("data", None)
        request["headers"] = scrub_value(request.get("headers"))

    event["extra"] = scrub_value(event.get("extra"))
    event["contexts"] = scrub_value(event.get("contexts"))
    event["breadcrumbs"] = [
        {**breadcrumb, "data": scrub_value(breadcrumb.get("data"))}
        for breadcrumb in event.get("breadcrumbs", [])
        if isinstance(breadcrumb, dict)
    ]

    return event


def is_sentry_enabled() -> bool:
    return bool(os.getenv("SENTRY_DSN"))


def scrub_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            key: "[Filtered]" if is_sensitive_key(str(key)) else scrub_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [scrub_value(item) for item in value]
    return value


def is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(keyword in normalized for keyword in SENSITIVE_KEYWORDS)
