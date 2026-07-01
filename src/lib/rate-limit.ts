import { NextResponse } from "next/server";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitEntry>();
const WINDOW_MS = 60 * 60 * 1000;

export function checkRateLimit(request: Request, options: { namespace: string; limit: number }) {
  const key = `${options.namespace}:${getClientKey(request)}`;
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  if (entry.count >= options.limit) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    return NextResponse.json(
      {
        error: `사용량 제한에 도달했습니다. ${Math.ceil(retryAfterSeconds / 60)}분 뒤 다시 시도해주세요.`
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds)
        }
      }
    );
  }

  entry.count += 1;
  return null;
}

function getClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip");
  return forwardedFor || realIp || "local";
}
