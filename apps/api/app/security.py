import os
import time
from collections import defaultdict, deque
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from fastapi import Header, HTTPException, Request
from starlette.middleware.cors import CORSMiddleware

try:
    import redis
except ImportError:  # pragma: no cover - optional production dependency
    redis = None

WINDOW_SECONDS = 60 * 60
KST = timezone(timedelta(hours=9))
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


def authenticated_quota_limiter(kind: str) -> Callable:
    user_limit_env = "USER_ANALYSIS_DAILY_LIMIT" if kind == "analysis" else "USER_EVALUATION_DAILY_LIMIT"
    ip_limit_env = "IP_ANALYSIS_DAILY_LIMIT" if kind == "analysis" else "IP_EVALUATION_DAILY_LIMIT"
    default_user_limit = 3 if kind == "analysis" else 10
    default_ip_limit = 20 if kind == "analysis" else 50

    def dependency(
        request: Request,
        proxy_secret: str | None = Header(default=None, alias="X-KYC-Proxy-Secret"),
        user_id: str | None = Header(default=None, alias="X-KYC-User-Id"),
        user_login: str | None = Header(default=None, alias="X-KYC-User-Login"),
    ) -> dict:
        if not auth_required():
            return {"userId": user_id or "anonymous", "userLogin": user_login or "anonymous"}

        expected_secret = os.getenv("API_PROXY_SECRET")
        if not expected_secret:
            raise HTTPException(status_code=503, detail="API 인증 설정이 누락되었습니다.")
        if proxy_secret != expected_secret:
            raise HTTPException(status_code=403, detail="허용되지 않은 API 요청입니다.")
        if not user_id or not user_login:
            raise HTTPException(status_code=401, detail="GitHub 로그인 정보가 필요합니다.")

        client = redis_client()
        if client is None:
            raise HTTPException(status_code=503, detail="사용량 제한 저장소에 연결할 수 없습니다.")

        today, reset_at, ttl = quota_window()
        user_limit = int(os.getenv(user_limit_env, str(default_user_limit)))
        ip_limit = int(os.getenv(ip_limit_env, str(default_ip_limit)))
        user_key = f"quota:user:{user_id}:{today}:{kind}"
        ip_key = f"quota:ip:{client_ip(request)}:{today}:{kind}"
        try:
            user_quota = ensure_daily_quota_available(client, user_key, user_limit, reset_at, ttl)
            ip_quota = ensure_daily_quota_available(client, ip_key, ip_limit, reset_at, ttl)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=503, detail="사용량 제한 저장소 처리 중 오류가 발생했습니다.") from exc

        return {
            "userId": user_id,
            "userLogin": user_login,
            kind: {"user": user_quota, "ip": ip_quota},
            "_quota": {
                "kind": kind,
                "ttl": ttl,
                "resetAt": reset_at,
                "user": {"key": user_key, "limit": user_limit},
                "ip": {"key": ip_key, "limit": ip_limit},
            },
        }

    return dependency


def authenticated_user(
    request: Request,
    proxy_secret: str | None = Header(default=None, alias="X-KYC-Proxy-Secret"),
    user_id: str | None = Header(default=None, alias="X-KYC-User-Id"),
    user_login: str | None = Header(default=None, alias="X-KYC-User-Login"),
) -> dict:
    if not auth_required():
        return {"userId": user_id or "anonymous", "userLogin": user_login or "anonymous"}

    expected_secret = os.getenv("API_PROXY_SECRET")
    if not expected_secret:
        raise HTTPException(status_code=503, detail="API 인증 설정이 누락되었습니다.")
    if proxy_secret != expected_secret:
        raise HTTPException(status_code=403, detail="허용되지 않은 API 요청입니다.")
    if not user_id or not user_login:
        raise HTTPException(status_code=401, detail="GitHub 로그인 정보가 필요합니다.")

    if redis_client() is None:
        raise HTTPException(status_code=503, detail="사용량 제한 저장소에 연결할 수 없습니다.")

    return {"userId": user_id, "userLogin": user_login, "ip": client_ip(request)}


def quota_status(user_id: str, ip: str) -> dict:
    client = redis_client()
    if client is None:
        raise HTTPException(status_code=503, detail="사용량 제한 저장소에 연결할 수 없습니다.")

    today, reset_at, _ttl = quota_window()
    return {
        "analysis": {
            "user": read_daily_quota(client, f"quota:user:{user_id}:{today}:analysis", int(os.getenv("USER_ANALYSIS_DAILY_LIMIT", "3")), reset_at),
            "ip": read_daily_quota(client, f"quota:ip:{ip}:{today}:analysis", int(os.getenv("IP_ANALYSIS_DAILY_LIMIT", "20")), reset_at),
        },
        "evaluation": {
            "user": read_daily_quota(client, f"quota:user:{user_id}:{today}:evaluation", int(os.getenv("USER_EVALUATION_DAILY_LIMIT", "10")), reset_at),
            "ip": read_daily_quota(client, f"quota:ip:{ip}:{today}:evaluation", int(os.getenv("IP_EVALUATION_DAILY_LIMIT", "50")), reset_at),
        },
    }


def auth_required() -> bool:
    return os.getenv("API_AUTH_REQUIRED", "false").lower() in {"1", "true", "yes", "on"}


def quota_window() -> tuple[str, str, int]:
    now = datetime.now(KST)
    tomorrow = (now + timedelta(days=1)).date()
    reset = datetime.combine(tomorrow, datetime.min.time(), tzinfo=KST)
    ttl = max(int((reset - now).total_seconds()), 1)
    return now.strftime("%Y%m%d"), reset.isoformat(), ttl


def consume_daily_quota(client, key: str, limit: int, ttl: int, reset_at: str) -> dict:
    if limit <= 0:
        return {"limit": limit, "remaining": 999999, "used": 0, "resetAt": reset_at}
    current = client.incr(key)
    if current == 1:
        client.expire(key, ttl)
    if current > limit:
        raise HTTPException(
            status_code=429,
            detail="오늘 사용 가능한 횟수를 모두 사용했습니다.",
            headers={
                "Retry-After": str(ttl),
                "X-RateLimit-Limit": str(limit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": reset_at,
            },
        )
    return {"limit": limit, "remaining": max(limit - current, 0), "used": current, "resetAt": reset_at}


def ensure_daily_quota_available(client, key: str, limit: int, reset_at: str, retry_after: int) -> dict:
    if limit <= 0:
        return {"limit": limit, "remaining": 999999, "used": 0, "resetAt": reset_at}
    used = int(client.get(key) or 0)
    if used >= limit:
        raise HTTPException(
            status_code=429,
            detail="오늘 사용 가능한 횟수를 모두 사용했습니다.",
            headers={
                "Retry-After": str(retry_after),
                "X-RateLimit-Limit": str(limit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": reset_at,
            },
        )
    return {"limit": limit, "remaining": max(limit - used, 0), "used": used, "resetAt": reset_at}


def consume_authenticated_quota(quota: dict) -> dict | None:
    quota_context = quota.get("_quota")
    if not quota_context:
        return quota.get("analysis") or quota.get("evaluation")

    client = redis_client()
    if client is None:
        raise HTTPException(status_code=503, detail="사용량 제한 저장소에 연결할 수 없습니다.")

    try:
        user_target = quota_context["user"]
        ip_target = quota_context["ip"]
        reset_at = quota_context["resetAt"]
        ttl = int(quota_context["ttl"])
        user_quota = consume_daily_quota(client, user_target["key"], int(user_target["limit"]), ttl, reset_at)
        ip_quota = consume_daily_quota(client, ip_target["key"], int(ip_target["limit"]), ttl, reset_at)
        return {"user": user_quota, "ip": ip_quota}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="사용량 제한 저장소 처리 중 오류가 발생했습니다.") from exc


def read_daily_quota(client, key: str, limit: int, reset_at: str) -> dict:
    if limit <= 0:
        return {"limit": limit, "remaining": 999999, "used": 0, "resetAt": reset_at}
    used = int(client.get(key) or 0)
    return {"limit": limit, "remaining": max(limit - used, 0), "used": used, "resetAt": reset_at}


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
