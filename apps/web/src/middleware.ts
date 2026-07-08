import { NextResponse, type NextRequest } from "next/server";

const BOT_USER_AGENT_PATTERN =
  /(bot|crawler|spider|slurp|preview|facebookexternalhit|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot|yandex|baiduspider|duckduckbot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|gptbot|anthropic-ai|claude-web|google-extended|perplexitybot|amazonbot|applebot)/i;

const PROTECTED_PAGE_PREFIXES = [
  "/setup",
  "/analyzing",
  "/quiz",
  "/result",
  "/commit/analyzing",
  "/commit/quiz",
  "/commit/result"
];

const PROTECTED_API_PREFIXES = [
  "/api/analyze",
  "/api/analyze-commit",
  "/api/evaluate",
  "/api/evaluate-quiz",
  "/api/evaluate-commit-quiz",
  "/api/quota"
];

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (!isProtectedPath(path)) {
    return NextResponse.next();
  }

  const userAgent = request.headers.get("user-agent")?.trim() ?? "";
  if (isLikelyBot(userAgent)) {
    return new NextResponse("Blocked", {
      status: 403,
      headers: {
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store"
      }
    });
  }

  const response = NextResponse.next();
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

function isProtectedPath(path: string): boolean {
  return PROTECTED_PAGE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    || PROTECTED_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isLikelyBot(userAgent: string): boolean {
  return !userAgent || BOT_USER_AGENT_PATTERN.test(userAgent);
}

export const config = {
  matcher: [
    "/setup/:path*",
    "/analyzing/:path*",
    "/quiz/:path*",
    "/result/:path*",
    "/commit/analyzing/:path*",
    "/commit/quiz/:path*",
    "/commit/result/:path*",
    "/api/analyze/:path*",
    "/api/analyze-commit/:path*",
    "/api/evaluate/:path*",
    "/api/evaluate-quiz/:path*",
    "/api/evaluate-commit-quiz/:path*",
    "/api/quota/:path*"
  ]
};
