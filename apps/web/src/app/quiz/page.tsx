"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import {
  loadAnalysisResult,
  loadQuizSession,
  saveQuizSession,
  type QuizSession
} from "@/lib/analysis-session";
import type { AnalysisResult, CodeEvidence, QuizAnswer, QuizEvaluationResult } from "@/lib/types";

type QuizState = "answering" | "evaluating" | "error";
type UsageLimit = {
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds?: number;
};

export default function QuizPage() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [answerDraft, setAnswerDraft] = useState("");
  const [quizState, setQuizState] = useState<QuizState>("answering");
  const [error, setError] = useState("");
  const [evaluateLimit, setEvaluateLimit] = useState<UsageLimit | undefined>();
  const [selectedSnippetPath, setSelectedSnippetPath] = useState<string | null>(null);

  useEffect(() => {
    const storedAnalysis = loadAnalysisResult();
    if (!storedAnalysis) {
      router.replace("/");
      return;
    }

    const storedQuiz = loadQuizSession();
    const nextIndex = clampIndex(storedQuiz?.currentQuestionIndex ?? 0, storedAnalysis.questions.length);
    const nextAnswers = storedQuiz?.answers ?? [];

    setAnalysis(storedAnalysis);
    setCurrentIndex(nextIndex);
    setAnswers(nextAnswers);
    setAnswerDraft(nextAnswers.find((answer) => answer.questionId === storedAnalysis.questions[nextIndex]?.id)?.answer ?? "");

    if (storedQuiz?.evaluation) {
      router.replace("/result");
    }
  }, [router]);

  const currentQuestion = analysis?.questions[currentIndex] ?? null;
  const progress = analysis ? Math.round(((currentIndex + 1) / analysis.questions.length) * 100) : 0;
  const answeredCount = useMemo(
    () => analysis?.questions.filter((question) => answers.some((answer) => answer.questionId === question.id && answer.answer.trim())).length ?? 0,
    [analysis, answers]
  );

  function persist(next: Partial<QuizSession>) {
    const session: QuizSession = {
      currentQuestionIndex: next.currentQuestionIndex ?? currentIndex,
      answers: next.answers ?? answers,
      evaluation: next.evaluation ?? null
    };
    saveQuizSession(session);
  }

  function upsertAnswer(questionId: string, value: string): QuizAnswer[] {
    const withoutCurrent = answers.filter((answer) => answer.questionId !== questionId);
    return [...withoutCurrent, { questionId, answer: value }];
  }

  function moveTo(index: number, nextAnswers = answers) {
    if (!analysis) return;
    const nextIndex = clampIndex(index, analysis.questions.length);
    setCurrentIndex(nextIndex);
    setAnswerDraft(nextAnswers.find((answer) => answer.questionId === analysis.questions[nextIndex]?.id)?.answer ?? "");
    persist({ currentQuestionIndex: nextIndex, answers: nextAnswers });
  }

  function handlePrevious() {
    if (!currentQuestion) return;
    const nextAnswers = upsertAnswer(currentQuestion.id, answerDraft);
    setAnswers(nextAnswers);
    moveTo(currentIndex - 1, nextAnswers);
  }

  function handleNext() {
    if (!analysis || !currentQuestion || !answerDraft.trim()) return;
    const nextAnswers = upsertAnswer(currentQuestion.id, answerDraft.trim());
    setAnswers(nextAnswers);
    moveTo(currentIndex + 1, nextAnswers);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!analysis || !currentQuestion || !answerDraft.trim()) return;

    const nextAnswers = upsertAnswer(currentQuestion.id, answerDraft.trim());
    setAnswers(nextAnswers);
    persist({ answers: nextAnswers });

    if (currentIndex < analysis.questions.length - 1) {
      moveTo(currentIndex + 1, nextAnswers);
      return;
    }

    setQuizState("evaluating");
    setError("");

    try {
      const response = await fetch("/api/evaluate-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysis, answers: nextAnswers })
      });
      const data = await response.json();
      setEvaluateLimit(data.limit ?? data.limits?.evaluate ?? evaluateLimit);

      if (!response.ok) {
        setQuizState("error");
        setError(data.error ?? "퀴즈 평가에 실패했습니다. 잠시 후 다시 시도해주세요.");
        return;
      }

      const evaluation = data.evaluation as QuizEvaluationResult;
    saveQuizSession({
      currentQuestionIndex: currentIndex,
      answers: nextAnswers,
      evaluation
    });
    track("quiz_completed", { questionCount: analysis.questions.length });
    router.push("/result");
  } catch (caughtError) {
      setQuizState("error");
      setError(caughtError instanceof Error ? caughtError.message : "퀴즈 평가 중 네트워크 오류가 발생했습니다.");
    }
  }

  if (!analysis || !currentQuestion) return null;

  const isLastQuestion = currentIndex === analysis.questions.length - 1;
  const relatedSnippets = getRelatedSnippets(currentQuestion.evidenceSnippets, analysis.contextFiles, currentQuestion.relatedFiles);
  const selectedSnippet = selectedSnippetPath ? relatedSnippets.find((snippet) => snippet.id === selectedSnippetPath || snippet.path === selectedSnippetPath) ?? null : null;

  return (
    <main>
      <SiteNav />
      <section className={selectedSnippet ? "quiz-page is-code-open" : "quiz-page"}>
        <div className={selectedSnippet ? "quiz-shell is-code-open" : "quiz-shell"}>
          <div className="quiz-main-column">
            <div className="quiz-header">
              <div>
                <p className="section-label">이해도 테스트</p>
                <h1>{analysis.repo.owner}/{analysis.repo.repo}</h1>
                <p>질문에 하나씩 답변하면 마지막에 코드 근거 기반 리포트를 보여드립니다.</p>
              </div>
              <div className="quiz-counter">
                <strong>{currentIndex + 1}</strong>
                <span>/ {analysis.questions.length}</span>
              </div>
            </div>

            <div className="quiz-progress" aria-label={`진행률 ${progress}%`}>
              <span style={{ width: `${progress}%` }} />
            </div>

            <form className="quiz-card" onSubmit={handleSubmit}>
              <div className="quiz-question">
                <div className="quiz-question__meta">
                  <span>{currentQuestion.type}</span>
                  <span>{answeredCount}/{analysis.questions.length} 답변 완료</span>
                </div>
                <h2>{currentQuestion.question}</h2>
              </div>

              <aside className="quiz-related">
                <p className="section-label">관련 파일</p>
                <ul>
                  {relatedSnippets.map((snippet) => (
                    <li key={snippet.id}>
                      <button
                        type="button"
                        className={selectedSnippet?.id === snippet.id ? "is-active" : ""}
                        onClick={() => setSelectedSnippetPath(snippet.id)}
                      >
                        {snippet.title || snippet.path}
                      </button>
                    </li>
                  ))}
                </ul>
              </aside>

              <label className="quiz-answer" htmlFor="quizAnswer">
                <span>내 답변</span>
                <textarea
                  id="quizAnswer"
                  value={answerDraft}
                  onChange={(event) => {
                    setAnswerDraft(event.target.value);
                    if (quizState === "error") {
                      setQuizState("answering");
                      setError("");
                    }
                  }}
                  placeholder="파일명, 처리 흐름, 수정 영향 범위를 연결해서 답변해보세요."
                  maxLength={4000}
                  disabled={quizState === "evaluating"}
                />
              </label>

              {quizState === "evaluating" ? <QuizEvaluating /> : null}
              {quizState === "error" ? <p className="error">{error}</p> : null}

              <div className="quiz-actions">
                <button className="secondary-button" type="button" onClick={() => router.push("/setup")} disabled={quizState === "evaluating"}>
                  설정 수정
                </button>
                <div>
                  <button className="secondary-button" type="button" onClick={handlePrevious} disabled={currentIndex === 0 || quizState === "evaluating"}>
                    이전
                  </button>
                  <button className="primary-button" type={isLastQuestion ? "submit" : "button"} onClick={isLastQuestion ? undefined : handleNext} disabled={!answerDraft.trim() || quizState === "evaluating"}>
                    {quizState === "evaluating" ? "평가 중" : quizState === "error" ? "다시 평가하기 →" : isLastQuestion ? "결과 보기 →" : "다음 →"}
                  </button>
                </div>
              </div>
              <p className="usage-note">답변은 문항별 최대 4,000자입니다. 평가는 마지막에 한 번만 진행됩니다.</p>
            </form>
          </div>
          {selectedSnippet ? (
            <CodePanel snippet={selectedSnippet} title="코드 미리보기" onClose={() => setSelectedSnippetPath(null)} />
          ) : null}
        </div>
      </section>
    </main>
  );
}

function QuizEvaluating() {
  return (
    <div className="evaluation-loading">
      <span className="evaluation-loading__spinner" aria-hidden="true" />
      <div>
        <strong>답변 5개를 종합 평가하는 중입니다</strong>
        <p>문항별 점수, 부족한 설명, 다시 볼 파일을 한 번에 정리하고 있습니다.</p>
      </div>
    </div>
  );
}

function CodePanel({
  snippet,
  title,
  onClose
}: {
  snippet: CodeEvidence;
  title: string;
  onClose: () => void;
}) {
  return (
    <aside className="quiz-code-panel">
      <div className="quiz-code-panel__title">
        <p className="section-label">{title}</p>
        <button type="button" onClick={onClose}>닫기</button>
      </div>
      <div className="quiz-code-panel__header">
        <strong>{snippet.path}</strong>
        <span>{snippet.reason}</span>
      </div>
      {snippet.excerpt ? (
        <pre>{snippet.excerpt}</pre>
      ) : (
        <div className="code-preview-empty">
          <strong>미리보기 가능한 코드가 없습니다.</strong>
          <p>이 파일은 분석 컨텍스트에 포함되지 않았거나 GitHub API에서 본문을 제공하지 않은 파일입니다. 답변할 때는 파일명과 질문의 맥락을 기준으로 설명해주세요.</p>
        </div>
      )}
    </aside>
  );
}

function getRelatedSnippets(
  evidenceSnippets: CodeEvidence[] | undefined,
  contextFiles: Array<{ path: string; reason: string; excerpt: string }>,
  relatedFiles: string[]
) : CodeEvidence[] {
  if (evidenceSnippets?.length) {
    return [...new Map(evidenceSnippets.map((snippet) => [snippet.id, snippet])).values()].slice(0, 3);
  }

  const snippets: CodeEvidence[] = relatedFiles.map((path) => {
    const matched = contextFiles.find((file) => file.path === path) ?? contextFiles.find((file) => file.path.endsWith(path) || path.endsWith(file.path));
    const fallback = matched ?? { path, reason: "관련 파일로 제시되었지만 미리보기 본문은 제공되지 않았습니다.", excerpt: "" };
    return {
      id: fallback.path,
      path: fallback.path,
      title: fallback.path,
      reason: fallback.reason,
      excerpt: fallback.excerpt,
      kind: "other"
    };
  });

  return [...new Map(snippets.map((file) => [file.path, file])).values()].slice(0, 3);
}

function clampIndex(index: number, length: number): number {
  if (!length) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function SiteNav() {
  return (
    <nav className="site-nav">
      <div className="site-nav__inner">
        <div className="brand">
          <span className="brand__mark">KYC</span>
          <span>KnowYourCode</span>
        </div>
      </div>
    </nav>
  );
}
