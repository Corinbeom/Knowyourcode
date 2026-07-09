import { NextResponse } from "next/server";
import { generateCommitAnalysis } from "@/lib/ai";
import { buildCommitStaticContext, buildFallbackCommitAnalysis } from "@/lib/commit-analysis";
import { fetchCommitChanges, parseGitHubCommitUrl } from "@/lib/github";
import { authErrorResponse, requireBackendAuth, type BackendAuth } from "@/lib/backend-auth";
import { consumeRateLimit } from "@/lib/rate-limit";
import { captureBackendResponseError, captureRouteError } from "@/lib/sentry";
import { backendApiUrl, webRuntimeConfigErrorResponse } from "@/lib/web-runtime-config";

export const runtime = "nodejs";
const ANALYZE_LIMIT_PER_HOUR = Number(process.env.ANALYZE_LIMIT_PER_HOUR ?? 5);

export async function POST(request: Request) {
  try {
    const configError = webRuntimeConfigErrorResponse();
    if (configError) return configError;

    const body = (await request.json()) as { url?: string };
    if (!body.url) {
      return NextResponse.json({ error: "GitHub commit URL을 입력해주세요." }, { status: 400 });
    }

    const backendAuth = await getBackendAuth();
    if (backendAuth instanceof Response) return backendAuth;

    const proxied = await proxyAnalyzeCommit(body.url, backendAuth);
    if (proxied) return proxied;

    const rateLimit = consumeRateLimit(request, {
      namespace: "analyze-commit",
      limit: ANALYZE_LIMIT_PER_HOUR
    });
    if (rateLimit.response) return rateLimit.response;

    const commitInput = parseGitHubCommitUrl(body.url);
    const commitChanges = await fetchCommitChanges(commitInput);

    if (!commitChanges.files.length) {
      return NextResponse.json(
        { error: "분석 가능한 커밋 변경 파일을 찾지 못했습니다." },
        { status: 422 }
      );
    }

    const context = buildCommitStaticContext(commitChanges);
    const fallback = buildFallbackCommitAnalysis(context);
    const analysis = await generateCommitAnalysis(context, fallback);

    return NextResponse.json({
      analysis,
      limits: {
        analyze: rateLimit.meta
      }
    });
  } catch (error) {
    captureRouteError(error, {
      mode: "commit",
      route: "/api/analyze-commit",
      provider: "web-local"
    });
    const message = error instanceof Error ? error.message : "커밋 분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function proxyAnalyzeCommit(url: string, backendAuth: BackendAuth): Promise<NextResponse | null> {
  const backendUrl = backendApiUrl();
  if (!backendUrl) return null;

  const response = await fetch(`${backendUrl}/analyze-commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...backendAuth.headers },
    body: JSON.stringify({ url }),
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    captureBackendResponseError("/api/analyze-commit", "commit", response.status);
    const message = typeof data.detail === "string" ? data.detail : data.error ?? "커밋 분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: response.status });
  }

  return NextResponse.json({
    ...data,
    limits: { backend: data.limits }
  });
}

async function getBackendAuth(): Promise<BackendAuth | Response> {
  try {
    return await requireBackendAuth();
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "인증 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
