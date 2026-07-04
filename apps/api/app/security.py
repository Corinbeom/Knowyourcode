import os
import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import HTTPException, Request
from starlette.middleware.cors import CORSMiddleware

try:
    import redis
except ImportError:  # pragma: no cover - optional production dependency
    redis = None

WINDOW_SECONDS = 60 * 60
DEFAULT_ALLOWED_ORIGINS = "https://knowyourcode.cloud,https://www.knowyourcode.cloud,https://knowyourcode.vercel.app"

_requests: dict[str, deque[float]] = defaultdict(deque)
_redis_client = None


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

        if consume_redis_limit(namespace, client_ip(request), limit):
            return

        if _redis_client is not None:
            raise_rate_limit(WINDOW_SECONDS)

        now = time.time()
        key = f"{namespace}:{client_ip(request)}"
        history = _requests[key]

        while history and history[0] <= now - WINDOW_SECONDS:
            history.popleft()

        if len(history) >= limit:
            retry_after = max(int(WINDOW_SECONDS - (now - history[0])), 1)
            raise_rate_limit(retry_after)

        history.append(now)

    return dependency


def consume_redis_limit(namespace: str, ip: str, limit: int) -> bool:
    global _redis_client
    client = redis_client()
    if client is None:
        return False

    key = f"rate:{namespace}:{ip}"
    try:
        current = client.incr(key)
        if current == 1:
            client.expire(key, WINDOW_SECONDS)
        if current > limit:
            ttl = client.ttl(key)
            raise_rate_limit(ttl if ttl and ttl > 0 else WINDOW_SECONDS)
        return True
    except HTTPException:
        raise
    except Exception:
        _redis_client = None
        return False


def redis_client():
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    redis_url = os.getenv("REDIS_URL")
    if not redis_url or redis is None:
        return None

    try:
        _redis_client = redis.Redis.from_url(redis_url, decode_responses=True)
        _redis_client.ping()
        return _redis_client
    except Exception:
        _redis_client = None
        return None


def raise_rate_limit(retry_after: int) -> None:
    raise HTTPException(
        status_code=429,
        detail="요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
        headers={"Retry-After": str(retry_after)},
    )
