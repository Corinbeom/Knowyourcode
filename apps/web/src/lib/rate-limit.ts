import { NextResponse } from "next/server";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type RateLimitMeta = {
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds?: number;
};

export type RateLimitResult = {
  response: NextResponse | null;
  meta: RateLimitMeta;
};

const buckets = new Map<string, RateLimitEntry>();
const WINDOW_MS = 60 * 60 * 1000;

export function consumeRateLimit(request: Request, options: { namespace: string; limit: number }): RateLimitResult {
  const key = `${options.namespace}:${getClientKey(request)}`;
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    const nextEntry = { count: 1, resetAt: now + WINDOW_MS };
    buckets.set(key, nextEntry);
    return {
      response: null,
      meta: buildMeta(options.limit, nextEntry.count, nextEntry.resetAt)
    };
  }

  if (entry.count >= options.limit) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    const meta = buildMeta(options.limit, entry.count, entry.resetAt, retryAfterSeconds);
    return {
      response: NextResponse.json(
        {
          error: `사용량 제한에 도달했습니다. ${Math.ceil(retryAfterSeconds / 60)}분 뒤 다시 시도해주세요.`,
          limit: meta
        },
        {
          status: 429,
          headers: {
            ...buildHeaders(meta),
            "Retry-After": String(retryAfterSeconds)
          }
        }
      ),
      meta
    };
  }

  entry.count += 1;
  return {
    response: null,
    meta: buildMeta(options.limit, entry.count, entry.resetAt)
  };
}

function getClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip");
  return forwardedFor || realIp || "local";
}

function buildMeta(limit: number, count: number, resetAt: number, retryAfterSeconds?: number): RateLimitMeta {
  return {
    limit,
    remaining: Math.max(limit - count, 0),
    resetAt: new Date(resetAt).toISOString(),
    retryAfterSeconds
  };
}

function buildHeaders(meta: RateLimitMeta): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(meta.limit),
    "X-RateLimit-Remaining": String(meta.remaining),
    "X-RateLimit-Reset": meta.resetAt
  };
}
