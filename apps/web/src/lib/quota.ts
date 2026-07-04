export type QuotaBucket = {
  limit: number;
  remaining: number;
  used: number;
  resetAt: string;
};

export type QuotaStatus = {
  analysis: {
    user: QuotaBucket;
    ip: QuotaBucket;
  };
  evaluation: {
    user: QuotaBucket;
    ip: QuotaBucket;
  };
};

export function effectiveRemaining(limit?: { user?: QuotaBucket; ip?: QuotaBucket }): number | null {
  if (!limit?.user || !limit?.ip) return null;
  return Math.min(limit.user.remaining, limit.ip.remaining);
}

export function formatResetTime(resetAt?: string): string {
  if (!resetAt) return "내일 0시";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(resetAt));
}
