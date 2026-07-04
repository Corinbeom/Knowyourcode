import { NextResponse } from "next/server";
import { generateCommitAnalysis } from "@/lib/ai";
import { buildCommitStaticContext, buildFallbackCommitAnalysis } from "@/lib/commit-analysis";
import { fetchCommitChanges, parseGitHubCommitUrl } from "@/lib/github";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
const ANALYZE_LIMIT_PER_HOUR = Number(process.env.ANALYZE_LIMIT_PER_HOUR ?? 5);

export async function POST(request: Request) {
  try {
    const rateLimit = consumeRateLimit(request, {
      namespace: "analyze-commit",
      limit: ANALYZE_LIMIT_PER_HOUR
    });
    if (rateLimit.response) return rateLimit.response;

    const body = (await request.json()) as { url?: string };
    if (!body.url) {
      return NextResponse.json({ error: "GitHub commit URL을 입력해주세요." }, { status: 400 });
    }

    const proxied = await proxyAnalyzeCommit(body.url, rateLimit.meta);
    if (proxied) return proxied;

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
    const message = error instanceof Error ? error.message : "커밋 분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function proxyAnalyzeCommit(url: string, limitMeta: unknown): Promise<NextResponse | null> {
  const backendUrl = process.env.BACKEND_API_URL?.replace(/\/$/, "");
  if (!backendUrl) return null;

  const response = await fetch(`${backendUrl}/analyze-commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = typeof data.detail === "string" ? data.detail : data.error ?? "커밋 분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: response.status });
  }

  return NextResponse.json({
    ...data,
    limits: {
      analyze: limitMeta
    }
  });
}
