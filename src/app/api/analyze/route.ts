import { NextResponse } from "next/server";
import { generateAnalysis } from "@/lib/ai";
import { fetchRepoFiles, parseGitHubUrl } from "@/lib/github";
import { consumeRateLimit } from "@/lib/rate-limit";
import { buildFallbackAnalysis, buildStaticContext } from "@/lib/repo-analysis";
import type { AnalysisFocus, QuestionLevel } from "@/lib/types";

export const runtime = "nodejs";
const ANALYZE_LIMIT_PER_HOUR = Number(process.env.ANALYZE_LIMIT_PER_HOUR ?? 5);

export async function POST(request: Request) {
  try {
    const rateLimit = consumeRateLimit(request, {
      namespace: "analyze",
      limit: ANALYZE_LIMIT_PER_HOUR
    });
    if (rateLimit.response) return rateLimit.response;

    const body = (await request.json()) as {
      url?: string;
      focus?: AnalysisFocus;
      questionLevel?: QuestionLevel;
      questionTargets?: string[] | string;
    };
    if (!body.url) {
      return NextResponse.json({ error: "GitHub URL을 입력해주세요." }, { status: 400 });
    }

    const focus = normalizeFocus(body.focus);
    const questionLevel = normalizeQuestionLevel(body.questionLevel);
    const questionTargets = normalizeQuestionTargets(body.questionTargets);
    const repo = parseGitHubUrl(body.url);
    const files = await fetchRepoFiles(repo);

    if (!files.length) {
      return NextResponse.json(
        { error: "분석 가능한 텍스트 파일을 찾지 못했습니다." },
        { status: 422 }
      );
    }

    const context = buildStaticContext(repo, files, focus, questionLevel, questionTargets);
    const fallback = buildFallbackAnalysis(
      repo,
      files.length,
      focus,
      questionLevel,
      questionTargets,
      context.contextFiles,
      context.tree,
      context.packageInfo
    );
    const analysis = await generateAnalysis(context, fallback);

    return NextResponse.json({
      analysis,
      limits: {
        analyze: rateLimit.meta
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function normalizeFocus(focus: AnalysisFocus | undefined): AnalysisFocus {
  if (focus === "frontend" || focus === "backend") return focus;
  return "balanced";
}

function normalizeQuestionLevel(questionLevel: QuestionLevel | undefined): QuestionLevel {
  if (questionLevel === "basic" || questionLevel === "deep") return questionLevel;
  return "standard";
}

function normalizeQuestionTargets(input: string[] | string | undefined): string[] {
  const rawTargets = Array.isArray(input) ? input : (input ?? "").split(/[,;\n]/);
  return rawTargets
    .map((target) => target.trim())
    .filter(Boolean)
    .map((target) => target.slice(0, 32))
    .filter((target, index, targets) => targets.indexOf(target) === index)
    .slice(0, 5);
}
