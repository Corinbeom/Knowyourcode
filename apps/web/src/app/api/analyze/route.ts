import { NextResponse } from "next/server";
import { generateAnalysis } from "@/lib/ai";
import { fetchRepoFiles, parseGitHubUrl } from "@/lib/github";
import { authErrorResponse, requireBackendAuth, type BackendAuth } from "@/lib/backend-auth";
import { consumeRateLimit } from "@/lib/rate-limit";
import { buildFallbackAnalysis, buildStaticContext } from "@/lib/repo-analysis";
import { sanitizeRepoAnalysis } from "@/lib/repo-question-sanitizer";
import type { AnalysisFocus, QuestionLevel, QuestionType } from "@/lib/types";

export const runtime = "nodejs";
const ANALYZE_LIMIT_PER_HOUR = Number(process.env.ANALYZE_LIMIT_PER_HOUR ?? 5);
const QUESTION_TYPES: QuestionType[] = ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"];

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      url?: string;
      focus?: AnalysisFocus;
      questionLevel?: QuestionLevel;
      questionTypes?: QuestionType[];
      questionTargets?: string[] | string;
    };
    if (!body.url) {
      return NextResponse.json({ error: "GitHub URL을 입력해주세요." }, { status: 400 });
    }

    const backendAuth = await getBackendAuth();
    if (backendAuth instanceof Response) return backendAuth;

    const focus = normalizeFocus(body.focus);
    const questionLevel = normalizeQuestionLevel(body.questionLevel);
    const questionTypes = normalizeQuestionTypes(body.questionTypes);
    const questionTargets = normalizeQuestionTargets(body.questionTargets);

    const proxied = await proxyAnalyzeRepo(
      {
        url: body.url,
        focus,
        questionLevel,
        questionTypes,
        questionTargets
      },
      backendAuth
    );
    if (proxied) return proxied;

    const rateLimit = consumeRateLimit(request, {
      namespace: "analyze",
      limit: ANALYZE_LIMIT_PER_HOUR
    });
    if (rateLimit.response) return rateLimit.response;

    const repo = parseGitHubUrl(body.url);
    const files = await fetchRepoFiles(repo);

    if (!files.length) {
      return NextResponse.json(
        { error: "분석 가능한 텍스트 파일을 찾지 못했습니다." },
        { status: 422 }
      );
    }

    const context = buildStaticContext(repo, files, focus, questionLevel, questionTypes, questionTargets);
    const fallback = buildFallbackAnalysis(
      repo,
      files.length,
      focus,
      questionLevel,
      questionTypes,
      questionTargets,
      context.contextFiles,
      context.tree,
      context.packageInfo,
      context.evidenceSnippets
    );
    const analysis = await generateAnalysis(context, fallback);

    return NextResponse.json({
      analysis: sanitizeRepoAnalysis(analysis),
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

function normalizeQuestionTypes(input: QuestionType[] | undefined): QuestionType[] {
  if (!Array.isArray(input)) return QUESTION_TYPES;
  const selected = input.filter((type): type is QuestionType => QUESTION_TYPES.includes(type));
  return selected.length ? [...new Set(selected)] : QUESTION_TYPES;
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

async function proxyAnalyzeRepo(
  body: {
    url: string;
    focus: AnalysisFocus;
    questionLevel: QuestionLevel;
    questionTypes: QuestionType[];
    questionTargets: string[];
  },
  backendAuth: BackendAuth
): Promise<NextResponse | null> {
  const backendUrl = process.env.BACKEND_API_URL?.replace(/\/$/, "");
  if (!backendUrl) return null;

  const response = await fetch(`${backendUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...backendAuth.headers },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = typeof data.detail === "string" ? data.detail : data.error ?? "분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: response.status });
  }

  return NextResponse.json({
    ...data,
    analysis: data.analysis ? sanitizeRepoAnalysis(data.analysis) : data.analysis,
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
