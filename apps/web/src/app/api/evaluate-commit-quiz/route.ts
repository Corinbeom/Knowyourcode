import { NextResponse } from "next/server";
import { evaluateCommitQuiz, requiresLocalQuizEvaluation } from "@/lib/ai";
import { authErrorResponse, requireBackendAuth, type BackendAuth } from "@/lib/backend-auth";
import { payloadTooLargeResponse, readEvaluationJson, validateEvaluationAnalysis } from "@/lib/evaluation-payload";
import { consumeRateLimit } from "@/lib/rate-limit";
import { captureBackendResponseError, captureRouteError } from "@/lib/sentry";
import { backendApiUrl, webRuntimeConfigErrorResponse } from "@/lib/web-runtime-config";
import type { CommitAnalysisResult, QuizAnswer } from "@/lib/types";

export const runtime = "nodejs";
const EVALUATE_LIMIT_PER_HOUR = Number(process.env.EVALUATE_LIMIT_PER_HOUR ?? 10);
const MAX_ANSWER_LENGTH = Number(process.env.MAX_ANSWER_LENGTH ?? 4000);

export async function POST(request: Request) {
  try {
    const configError = webRuntimeConfigErrorResponse();
    if (configError) return configError;

    const body = await readEvaluationJson<{
      analysis?: CommitAnalysisResult;
      answers?: QuizAnswer[];
    }>(request);

    if (!body.analysis || !Array.isArray(body.answers)) {
      return NextResponse.json(
        { error: "커밋 분석 결과와 답변 목록을 모두 입력해주세요." },
        { status: 400 }
      );
    }
    const analysisError = validateEvaluationAnalysis(body.analysis);
    if (analysisError) return analysisError;

    const questionIds = new Set(body.analysis.questions.map((question) => question.id));
    const answers = body.answers
      .filter((answer) => questionIds.has(answer.questionId))
      .map((answer) => ({
        questionId: answer.questionId,
        answer: answer.answer.trim()
      }));

    if (answers.length !== body.analysis.questions.length || answers.some((answer) => !answer.answer)) {
      return NextResponse.json(
        { error: "모든 질문에 답변을 입력해주세요." },
        { status: 400 }
      );
    }

    if (answers.some((answer) => answer.answer.length > MAX_ANSWER_LENGTH)) {
      return NextResponse.json(
        { error: `각 답변은 ${MAX_ANSWER_LENGTH.toLocaleString("ko-KR")}자 이하로 입력해주세요.` },
        { status: 413 }
      );
    }

    const backendAuth = await getBackendAuth();
    if (backendAuth instanceof Response) return backendAuth;

    const proxied = requiresLocalQuizEvaluation(body.analysis, answers) ? null : await proxyEvaluation("evaluate-commit-quiz", {
      analysis: body.analysis,
      answers
    }, backendAuth);
    if (proxied) return proxied;

    const rateLimit = consumeRateLimit(request, {
      namespace: "evaluate-commit",
      limit: EVALUATE_LIMIT_PER_HOUR
    });
    if (rateLimit.response) return rateLimit.response;

    const evaluation = await evaluateCommitQuiz({
      analysis: body.analysis,
      answers
    });

    return NextResponse.json({ evaluation, limits: { evaluate: rateLimit.meta } });
  } catch (error) {
    const payloadError = payloadTooLargeResponse(error);
    if (payloadError) return payloadError;
    captureRouteError(error, {
      mode: "commit",
      route: "/api/evaluate-commit-quiz",
      provider: "web-local"
    });
    const message = error instanceof Error ? error.message : "커밋 퀴즈 평가 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function proxyEvaluation(path: string, body: unknown, backendAuth: BackendAuth): Promise<NextResponse | null> {
  const backendUrl = backendApiUrl();
  if (!backendUrl) return null;

  const response = await fetch(`${backendUrl}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...backendAuth.headers },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    captureBackendResponseError(`/api/${path}`, "commit", response.status);
    const message = typeof data.detail === "string" ? data.detail : data.error ?? "커밋 퀴즈 평가 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: response.status });
  }

  return NextResponse.json({ ...data, limits: { backend: data.limits } });
}

async function getBackendAuth(): Promise<BackendAuth | Response> {
  try {
    return await requireBackendAuth();
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "인증 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
