import { describe, expect, it } from "vitest";

import { enforceDeterministicQuizGuards } from "./ai";
import type { CommitAnalysisResult, QuizEvaluationResult } from "./types";

const challenge = "제공된 코드에는 호출부와 결과 소비부가 없어 회귀 위험을 판단할 수 없습니다.";

function analysisFixture(): CommitAnalysisResult {
  return {
    questions: [
      {
        id: "q1",
        type: "변경 의도",
        question: "route.ts의 POST 변경 의도는 무엇인가요?",
        relatedFiles: ["route.ts"],
        evidenceSnippets: [{
          id: "route-post",
          path: "route.ts",
          title: "route.ts · POST",
          reason: "요청 처리 변경",
          excerpt: "export async function POST() { return handle(); }",
          kind: "modified",
          quality: "strong"
        }]
      },
      {
        id: "q4",
        type: "리뷰형",
        question: "buildFallbackCommitQuizEvaluation의 폴백 로직이 실제 LLM 평가를 대체하기에 충분한가요?",
        relatedFiles: ["lib/ai.ts"],
        evidenceSnippets: [{
          id: "fallback",
          path: "lib/ai.ts",
          title: "lib/ai.ts · buildFallbackCommitQuizEvaluation",
          reason: "정상 fallback 생성 과정",
          excerpt: "function fallback(items) { if (!items.length) return empty(); return build(items); }",
          kind: "modified",
          quality: "strong"
        }]
      }
    ]
  } as unknown as CommitAnalysisResult;
}

function backendEvaluationFixture(): QuizEvaluationResult {
  return {
    averageScore: 78,
    summary: "평가 결과",
    strengths: ["POST 흐름", "제공된 정보의 한계"],
    weaknesses: [],
    reviewFiles: ["route.ts", "lib/ai.ts"],
    questionEvaluations: [
      {
        questionId: "q1",
        score: 70,
        scoreReason: "정상",
        understood: ["POST 흐름"],
        missing: [],
        incorrect: [],
        relatedFiles: ["route.ts"],
        reviewCode: ["route.ts"],
        betterAnswer: "POST 흐름 설명",
        interviewAnswerDirection: "POST 설명",
        followUpQuestion: "후속 질문",
        evaluationStatus: "graded",
        answerType: "substantive"
      },
      {
        questionId: "q4",
        score: 85,
        scoreReason: "부분 이해",
        understood: ["제공된 정보의 한계"],
        missing: [],
        incorrect: [],
        relatedFiles: ["lib/ai.ts"],
        reviewCode: ["lib/ai.ts"],
        betterAnswer: "fallback 설명",
        interviewAnswerDirection: "fallback 설명",
        followUpQuestion: "후속 질문",
        evaluationStatus: "graded",
        answerType: "substantive"
      }
    ]
  };
}

describe("enforceDeterministicQuizGuards", () => {
  it("overrides a stale backend grade for the production Q4 challenge", () => {
    const result = enforceDeterministicQuizGuards(
      backendEvaluationFixture(),
      analysisFixture(),
      [
        { questionId: "q1", answer: "POST handler가 handle 결과를 반환합니다." },
        { questionId: "q4", answer: challenge }
      ]
    );
    const q4 = result.questionEvaluations.find((item) => item.questionId === "q4");

    expect(q4?.answerType).toBe("question_challenge");
    expect(q4?.evaluationStatus).toBe("invalid_question");
    expect(q4?.invalidReason).toContain("회귀 위험");
    expect(result.averageScore).toBe(70);
    expect(result.strengths).toEqual(["POST 흐름"]);
    expect(result.weaknesses).toEqual([]);
    expect(result.reviewFiles).toEqual(["route.ts"]);
  });

  it("keeps 모르겠습니다 as a graded insufficient answer", () => {
    const evaluation = backendEvaluationFixture();
    evaluation.questionEvaluations[1] = {
      ...evaluation.questionEvaluations[1],
      score: 5,
      understood: [],
      answerType: "insufficient"
    };
    const result = enforceDeterministicQuizGuards(
      evaluation,
      analysisFixture(),
      [{ questionId: "q1", answer: "POST handler를 설명합니다." }, { questionId: "q4", answer: "모르겠습니다." }]
    );

    expect(result.questionEvaluations[1].evaluationStatus).toBe("graded");
    expect(result.questionEvaluations[1].answerType).toBe("insufficient");
  });

  it("keeps a valid failure question graded but removes excessive credit", () => {
    const analysis = analysisFixture();
    const evidence = analysis.questions[1]?.evidenceSnippets?.[0];
    if (!evidence) throw new Error("Q4 evidence fixture is missing");
    evidence.excerpt = "try { return run(); } catch (error) { throw new HTTPException(413); }";
    const result = enforceDeterministicQuizGuards(
      backendEvaluationFixture(),
      analysis,
      [{ questionId: "q1", answer: "POST handler를 설명합니다." }, { questionId: "q4", answer: challenge }]
    );
    const q4 = result.questionEvaluations[1];

    expect(q4.evaluationStatus).toBe("graded");
    expect(q4.answerType).toBe("question_challenge");
    expect(q4.score).toBeLessThanOrEqual(20);
    expect(q4.understood).toEqual([]);
    expect(result.strengths).toEqual(["POST 흐름"]);
  });
});
