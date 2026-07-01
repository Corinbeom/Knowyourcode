import { NextResponse } from "next/server";
import { evaluateAnswer } from "@/lib/ai";
import { consumeRateLimit } from "@/lib/rate-limit";
import type { AnalysisResult } from "@/lib/types";

export const runtime = "nodejs";
const EVALUATE_LIMIT_PER_HOUR = Number(process.env.EVALUATE_LIMIT_PER_HOUR ?? 10);
const MAX_ANSWER_LENGTH = Number(process.env.MAX_ANSWER_LENGTH ?? 4000);

export async function POST(request: Request) {
  try {
    const rateLimit = consumeRateLimit(request, {
      namespace: "evaluate",
      limit: EVALUATE_LIMIT_PER_HOUR
    });
    if (rateLimit.response) return rateLimit.response;

    const body = (await request.json()) as {
      analysis?: AnalysisResult;
      questionId?: string;
      answer?: string;
    };

    if (!body.analysis || !body.questionId || !body.answer?.trim()) {
      return NextResponse.json(
        { error: "분석 결과, 질문, 답변을 모두 입력해주세요." },
        { status: 400 }
      );
    }

    if (body.answer.length > MAX_ANSWER_LENGTH) {
      return NextResponse.json(
        { error: `답변은 ${MAX_ANSWER_LENGTH.toLocaleString("ko-KR")}자 이하로 입력해주세요.` },
        { status: 413 }
      );
    }

    const evaluation = await evaluateAnswer({
      analysis: body.analysis,
      questionId: body.questionId,
      answer: body.answer.trim()
    });

    return NextResponse.json({ evaluation, limits: { evaluate: rateLimit.meta } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "평가 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
