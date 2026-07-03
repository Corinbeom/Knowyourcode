import { NextResponse } from "next/server";
import { evaluateCommitQuiz } from "@/lib/ai";
import { consumeRateLimit } from "@/lib/rate-limit";
import type { CommitAnalysisResult, QuizAnswer } from "@/lib/types";

export const runtime = "nodejs";
const EVALUATE_LIMIT_PER_HOUR = Number(process.env.EVALUATE_LIMIT_PER_HOUR ?? 10);
const MAX_ANSWER_LENGTH = Number(process.env.MAX_ANSWER_LENGTH ?? 4000);

export async function POST(request: Request) {
  try {
    const rateLimit = consumeRateLimit(request, {
      namespace: "evaluate-commit",
      limit: EVALUATE_LIMIT_PER_HOUR
    });
    if (rateLimit.response) return rateLimit.response;

    const body = (await request.json()) as {
      analysis?: CommitAnalysisResult;
      answers?: QuizAnswer[];
    };

    if (!body.analysis || !Array.isArray(body.answers)) {
      return NextResponse.json(
        { error: "커밋 분석 결과와 답변 목록을 모두 입력해주세요." },
        { status: 400 }
      );
    }

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

    const evaluation = await evaluateCommitQuiz({
      analysis: body.analysis,
      answers
    });

    return NextResponse.json({ evaluation, limits: { evaluate: rateLimit.meta } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "커밋 퀴즈 평가 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
