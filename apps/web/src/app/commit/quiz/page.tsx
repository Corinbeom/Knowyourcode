"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import {
  loadCommitAnalysisResult,
  loadCommitQuizSession,
  saveCommitQuizSession,
  type QuizSession
} from "@/lib/analysis-session";
import type { CommitAnalysisResult, QuizAnswer, QuizEvaluationResult } from "@/lib/types";

type QuizState = "answering" | "evaluating" | "error";

export default function CommitQuizPage() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<CommitAnalysisResult | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [answerDraft, setAnswerDraft] = useState("");
  const [quizState, setQuizState] = useState<QuizState>("answering");
  const [error, setError] = useState("");
  const [selectedSnippetPath, setSelectedSnippetPath] = useState<string | null>(null);

  useEffect(() => {
    const storedAnalysis = loadCommitAnalysisResult();
    if (!storedAnalysis) {
      router.replace("/");
      return;
    }

    const storedQuiz = loadCommitQuizSession();
    const nextIndex = clampIndex(storedQuiz?.currentQuestionIndex ?? 0, storedAnalysis.questions.length);
    const nextAnswers = storedQuiz?.answers ?? [];

    setAnalysis(storedAnalysis);
    setCurrentIndex(nextIndex);
    setAnswers(nextAnswers);
    setAnswerDraft(nextAnswers.find((answer) => answer.questionId === storedAnalysis.questions[nextIndex]?.id)?.answer ?? "");

    if (storedQuiz?.evaluation) {
      router.replace("/commit/result");
    }
  }, [router]);

  const currentQuestion = analysis?.questions[currentIndex] ?? null;
  const progress = analysis ? Math.round(((currentIndex + 1) / analysis.questions.length) * 100) : 0;
  const answeredCount = useMemo(
    () => analysis?.questions.filter((question) => answers.some((answer) => answer.questionId === question.id && answer.answer.trim())).length ?? 0,
    [analysis, answers]
  );

  function persist(next: Partial<QuizSession>) {
    saveCommitQuizSession({
      currentQuestionIndex: next.currentQuestionIndex ?? currentIndex,
      answers: next.answers ?? answers,
      evaluation: next.evaluation ?? null
    });
  }

  function upsertAnswer(questionId: string, value: string): QuizAnswer[] {
    return [...answers.filter((answer) => answer.questionId !== questionId), { questionId, answer: value }];
  }

  function moveTo(index: number, nextAnswers = answers) {
    if (!analysis) return;
    const nextIndex = clampIndex(index, analysis.questions.length);
    setCurrentIndex(nextIndex);
    setAnswerDraft(nextAnswers.find((answer) => answer.questionId === analysis.questions[nextIndex]?.id)?.answer ?? "");
    persist({ currentQuestionIndex: nextIndex, answers: nextAnswers });
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
      const response = await fetch("/api/evaluate-commit-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysis, answers: nextAnswers })
      });
      const data = await response.json();

      if (!response.ok) {
        setQuizState("error");
        setError(data.error ?? "커밋 퀴즈 평가에 실패했습니다. 잠시 후 다시 시도해주세요.");
        return;
      }

      const evaluation = data.evaluation as QuizEvaluationResult;
      saveCommitQuizSession({
        currentQuestionIndex: currentIndex,
        answers: nextAnswers,
        evaluation
      });
      track("commit_quiz_completed", { questionCount: analysis.questions.length });
      router.push("/commit/result");
    } catch (caughtError) {
      setQuizState("error");
      setError(caughtError instanceof Error ? caughtError.message : "커밋 퀴즈 평가 중 네트워크 오류가 발생했습니다.");
    }
  }

  if (!analysis || !currentQuestion) return null;

  const isLastQuestion = currentIndex === analysis.questions.length - 1;
  const relatedSnippets = getRelatedSnippets(analysis.contextFiles, currentQuestion.relatedFiles);
  const selectedSnippet = selectedSnippetPath ? relatedSnippets.find((snippet) => snippet.path === selectedSnippetPath) ?? null : null;

  return (
    <main>
      <SiteNav />
      <section className="quiz-page">
        <div className="quiz-header">
          <div>
            <p className="section-label">Commit Mode</p>
            <h1>{analysis.commit.repo}@{analysis.commit.shortSha}</h1>
            <p>이번 커밋의 변경 의도, 영향 범위, 테스트 리스크를 직접 설명해보세요.</p>
          </div>
          <div className="quiz-counter">
            <strong>{currentIndex + 1}</strong>
            <span>/ {analysis.questions.length}</span>
          </div>
        </div>

        <div className="quiz-progress" aria-label={`진행률 ${progress}%`}>
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className={selectedSnippet ? "quiz-workspace is-code-open" : "quiz-workspace"}>
          <form className="quiz-card" onSubmit={handleSubmit}>
            <div className="quiz-question">
              <div className="quiz-question__meta">
                <span>{currentQuestion.type}</span>
                <span>{answeredCount}/{analysis.questions.length} 답변 완료</span>
              </div>
              <h2>{currentQuestion.question}</h2>
            </div>

            <aside className="quiz-related">
              <p className="section-label">관련 변경 파일</p>
              <ul>
                {currentQuestion.relatedFiles.map((file) => (
                  <li key={file}>
                    <button
                      type="button"
                      className={isSelectedRelatedFile(selectedSnippet?.path, file) ? "is-active" : ""}
                      onClick={() => setSelectedSnippetPath(resolveSnippetPath(relatedSnippets, file))}
                    >
                      {file}
                    </button>
                  </li>
                ))}
              </ul>
            </aside>

            <label className="quiz-answer" htmlFor="commitQuizAnswer">
              <span>내 답변</span>
              <textarea
                id="commitQuizAnswer"
                value={answerDraft}
                onChange={(event) => {
                  setAnswerDraft(event.target.value);
                  if (quizState === "error") {
                    setQuizState("answering");
                    setError("");
                  }
                }}
                placeholder="커밋 메시지, 변경 파일, 영향 범위, 테스트 관점을 연결해서 답변해보세요."
                maxLength={4000}
                disabled={quizState === "evaluating"}
              />
            </label>

            {quizState === "evaluating" ? (
              <div className="evaluation-loading">
                <span className="evaluation-loading__spinner" aria-hidden="true" />
                <div>
                  <strong>커밋 답변을 diff 근거로 평가하는 중입니다</strong>
                  <p>변경 의도, 영향 범위, 테스트 리스크를 문항별로 정리하고 있습니다.</p>
                </div>
              </div>
            ) : null}
            {quizState === "error" ? <p className="error">{error}</p> : null}

            <div className="quiz-actions">
              <button className="secondary-button" type="button" onClick={() => router.push("/")} disabled={quizState === "evaluating"}>
                처음으로
              </button>
              <div>
                <button className="secondary-button" type="button" onClick={() => moveTo(currentIndex - 1)} disabled={currentIndex === 0 || quizState === "evaluating"}>
                  이전
                </button>
                <button className="primary-button" type={isLastQuestion ? "submit" : "button"} onClick={isLastQuestion ? undefined : () => {
                  if (!currentQuestion || !answerDraft.trim()) return;
                  const nextAnswers = upsertAnswer(currentQuestion.id, answerDraft.trim());
                  setAnswers(nextAnswers);
                  moveTo(currentIndex + 1, nextAnswers);
                }} disabled={!answerDraft.trim() || quizState === "evaluating"}>
                  {quizState === "evaluating" ? "평가 중" : quizState === "error" ? "다시 평가하기 →" : isLastQuestion ? "결과 보기 →" : "다음 →"}
                </button>
              </div>
            </div>
            <p className="usage-note">Commit Mode는 마지막에 한 번만 평가 API를 호출합니다.</p>
          </form>
          {selectedSnippet ? (
            <CodePanel snippet={selectedSnippet} title="변경 코드 미리보기" onClose={() => setSelectedSnippetPath(null)} />
          ) : null}
        </div>
      </section>
    </main>
  );
}

function clampIndex(index: number, length: number): number {
  if (!length) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function CodePanel({
  snippet,
  title,
  onClose
}: {
  snippet: { path: string; reason: string; excerpt: string };
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
          <strong>미리보기 가능한 diff가 없습니다.</strong>
          <p>이 파일은 GitHub API에서 patch를 제공하지 않았거나 분석 컨텍스트에 포함되지 않았습니다. 답변할 때는 파일명, 커밋 메시지, 질문의 변경 맥락을 기준으로 설명해주세요.</p>
        </div>
      )}
    </aside>
  );
}

function getRelatedSnippets(
  contextFiles: Array<{ path: string; reason: string; excerpt: string }>,
  relatedFiles: string[]
) {
  const snippets = relatedFiles.map((path) => {
    const matched = contextFiles.find((file) => file.path === path) ?? contextFiles.find((file) => file.path.endsWith(path) || path.endsWith(file.path));
    return matched ?? { path, reason: "관련 변경 파일로 제시되었지만 diff 미리보기는 제공되지 않았습니다.", excerpt: "" };
  });

  return [...new Map(snippets.map((file) => [file.path, file])).values()].slice(0, 3);
}

function resolveSnippetPath(snippets: Array<{ path: string }>, relatedFile: string): string {
  return snippets.find((snippet) => isSelectedRelatedFile(snippet.path, relatedFile))?.path ?? relatedFile;
}

function isSelectedRelatedFile(snippetPath: string | undefined, relatedFile: string): boolean {
  if (!snippetPath) return false;
  return snippetPath === relatedFile || snippetPath.endsWith(relatedFile) || relatedFile.endsWith(snippetPath);
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
