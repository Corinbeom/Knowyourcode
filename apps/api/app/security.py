import os
import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import HTTPException, Request
from starlette.middleware.cors import CORSMiddleware

WINDOW_SECONDS = 60 * 60
DEFAULT_ALLOWED_ORIGINS = "https://knowyourcode.cloud,https://www.knowyourcode.cloud,https://knowyourcode.vercel.app"

_requests: dict[str, deque[float]] = defaultdict(deque)


def docs_enabled() -> bool:
    explicit = os.getenv("API_DOCS_ENABLED")
    if explicit is not None:
        return explicit.lower() in {"1", "true", "yes", "on"}
    return os.getenv("API_ENV", "development").lower() != "production"


def allowed_origins() -> list[str]:
    raw = os.getenv("API_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS)
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def add_cors_middleware(app) -> None:
    origins = allowed_origins()
    if not origins:
        return

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )


def client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


def rate_limiter(namespace: str, limit_env: str, default_limit: int) -> Callable[[Request], None]:
    limit = int(os.getenv(limit_env, str(default_limit)))

    def dependency(request: Request) -> None:
        if limit <= 0:
            return

        now = time.time()
        key = f"{namespace}:{client_ip(request)}"
        history = _requests[key]

        while history and history[0] <= now - WINDOW_SECONDS:
            history.popleft()

        if len(history) >= limit:
            retry_after = max(int(WINDOW_SECONDS - (now - history[0])), 1)
            raise HTTPException(
                status_code=429,
                detail="요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
                headers={"Retry-After": str(retry_after)},
            )

        history.append(now)

    return dependency
