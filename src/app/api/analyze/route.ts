import { NextResponse } from "next/server";
import { generateAnalysis } from "@/lib/ai";
import { fetchRepoFiles, parseGitHubUrl } from "@/lib/github";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildFallbackAnalysis, buildStaticContext } from "@/lib/repo-analysis";

export const runtime = "nodejs";
const ANALYZE_LIMIT_PER_HOUR = Number(process.env.ANALYZE_LIMIT_PER_HOUR ?? 5);

export async function POST(request: Request) {
  try {
    const rateLimited = checkRateLimit(request, {
      namespace: "analyze",
      limit: ANALYZE_LIMIT_PER_HOUR
    });
    if (rateLimited) return rateLimited;

    const body = (await request.json()) as { url?: string };
    if (!body.url) {
      return NextResponse.json({ error: "GitHub URL을 입력해주세요." }, { status: 400 });
    }

    const repo = parseGitHubUrl(body.url);
    const files = await fetchRepoFiles(repo);

    if (!files.length) {
      return NextResponse.json(
        { error: "분석 가능한 텍스트 파일을 찾지 못했습니다." },
        { status: 422 }
      );
    }

    const context = buildStaticContext(repo, files);
    const fallback = buildFallbackAnalysis(
      repo,
      files.length,
      context.contextFiles,
      context.tree,
      context.packageInfo
    );
    const analysis = await generateAnalysis(context, fallback);

    return NextResponse.json({ analysis });
  } catch (error) {
    const message = error instanceof Error ? error.message : "분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
