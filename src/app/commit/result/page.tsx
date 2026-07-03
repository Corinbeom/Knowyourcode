"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import { loadCommitAnalysisResult, loadCommitQuizSession } from "@/lib/analysis-session";
import type { CommitAnalysisResult, QuizAnswer, QuizEvaluationResult, QuestionEvaluation } from "@/lib/types";

const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL || "https://tally.so/r/1AxeG1";

export default function CommitResultPage() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<CommitAnalysisResult | null>(null);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [evaluation, setEvaluation] = useState<QuizEvaluationResult | null>(null);

  useEffect(() => {
    const storedAnalysis = loadCommitAnalysisResult();
    if (!storedAnalysis) {
      router.replace("/");
      return;
    }

    const storedQuiz = loadCommitQuizSession();
    if (!storedQuiz?.evaluation) {
      router.replace("/commit/quiz");
      return;
    }

    setAnalysis(storedAnalysis);
    setAnswers(storedQuiz.answers);
    setEvaluation(storedQuiz.evaluation);
    track("commit_result_viewed", { averageScore: storedQuiz.evaluation.averageScore });
  }, [router]);

  const answerMap = useMemo(() => new Map(answers.map((answer) => [answer.questionId, answer.answer])), [answers]);

  if (!analysis || !evaluation) return null;

  return (
    <main>
      <SiteNav />
      <a className="floating-feedback-button" href={FEEDBACK_URL} target="_blank" rel="noreferrer" onClick={() => track("feedback_clicked", { source: "commit_result_floating" })}>
        피드백
      </a>
      <section className="workspace result-workspace">
        <div className="result-actions">
          <button className="secondary-button" type="button" onClick={() => router.push("/")}>
            새 분석 시작
          </button>
        </div>
        <section className="result-summary">
          <div>
            <p className="section-label">Commit Mode 결과</p>
            <h1>{analysis.commit.repo}@{analysis.commit.shortSha}</h1>
            <p>{evaluation.summary}</p>
            <div className="report__badges">
              <div className="focus-chip">커밋 단위</div>
              <div className="level-chip">+{analysis.totalAdditions} / -{analysis.totalDeletions}</div>
              <div className={analysis.ai.used ? "ai-chip is-live" : "ai-chip"}>
                {analysis.ai.used ? `${analysis.ai.provider} 분석` : "기본 분석"}
              </div>
            </div>
          </div>
          <div className="result-score">
            <strong>{evaluation.averageScore}</strong>
            <span>평균 점수</span>
          </div>
        </section>

        <CommitReportView analysis={analysis} />
        <CommitQuizResultView analysis={analysis} evaluation={evaluation} answerMap={answerMap} />
        <FeedbackCta />
      </section>
    </main>
  );
}

function CommitReportView({ analysis }: { analysis: CommitAnalysisResult }) {
  const { report } = analysis;

  return (
    <section className="report">
      <div className="report__header">
        <div>
          <p className="section-label">커밋 리포트</p>
          <h2>{analysis.commit.message}</h2>
        </div>
        <div className="report__badges">
          <div className="score-chip">{analysis.fileCount} files</div>
          <a className="secondary-link-button" href={analysis.commit.url} target="_blank" rel="noreferrer">
            GitHub에서 보기
          </a>
        </div>
      </div>
      {!analysis.ai.used && analysis.ai.reason ? <p className="notice">{analysis.ai.reason}</p> : null}
      <p className="summary">{report.oneLineSummary}</p>
      <div className="flow-grid">
        <article>
          <h3>변경 의도</h3>
          <p>{report.changeIntent}</p>
        </article>
        <InfoBlock title="영향 범위" items={report.impactScope} />
        <InfoBlock title="리뷰 위험" items={report.riskAreas} />
        <InfoBlock title="테스트 추천" items={report.testSuggestions} />
      </div>
      <div className="file-list">
        <div className="report-section-heading">
          <h3>변경 파일</h3>
          <p>이번 커밋에서 이해도 검증에 사용한 주요 변경 파일입니다.</p>
        </div>
        {report.changedFiles.map((file) => (
          <article key={file.path}>
            <strong>{file.path}</strong>
            <p>{file.reason}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function CommitQuizResultView({
  analysis,
  evaluation,
  answerMap
}: {
  analysis: CommitAnalysisResult;
  evaluation: QuizEvaluationResult;
  answerMap: Map<string, string>;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedEvaluation = evaluation.questionEvaluations[selectedIndex] ?? evaluation.questionEvaluations[0];
  const selectedQuestion = analysis.questions.find((candidate) => candidate.id === selectedEvaluation?.questionId);
  const questionCount = evaluation.questionEvaluations.length;

  function moveQuestion(direction: -1 | 1) {
    setSelectedIndex((current) => {
      const next = current + direction;
      if (next < 0) return questionCount - 1;
      if (next >= questionCount) return 0;
      return next;
    });
  }

  if (!selectedEvaluation || !selectedQuestion) return null;

  return (
    <section className="quiz-result">
      <div className="report-section-heading">
        <p className="section-label">커밋 퀴즈 피드백</p>
        <h3>문항별 결과</h3>
        <p>이번 변경을 얼마나 근거 있게 설명했는지 확인하세요.</p>
      </div>
      <div className="result-insights">
        <InfoBlock title="잘한 부분" items={evaluation.strengths} />
        <InfoBlock title="보완할 부분" items={evaluation.weaknesses} />
        <InfoBlock title="다시 볼 파일" items={evaluation.reviewFiles} />
      </div>
      <div className="question-score-nav" aria-label="문항별 점수">
        {evaluation.questionEvaluations.map((item, index) => (
          <button key={item.questionId} type="button" className={index === selectedIndex ? "is-active" : ""} onClick={() => setSelectedIndex(index)}>
            <span>Q{index + 1}</span>
            <strong>{item.score}</strong>
          </button>
        ))}
      </div>
      <div className="question-result-shell">
        <button className="question-arrow" type="button" onClick={() => moveQuestion(-1)} aria-label="이전 문항">
          &lt;
        </button>
        <QuestionResultCard
          index={selectedIndex}
          question={selectedQuestion.question}
          type={selectedQuestion.type}
          answer={answerMap.get(selectedEvaluation.questionId) ?? ""}
          evaluation={selectedEvaluation}
          total={questionCount}
        />
        <button className="question-arrow" type="button" onClick={() => moveQuestion(1)} aria-label="다음 문항">
          &gt;
        </button>
      </div>
    </section>
  );
}

function QuestionResultCard({
  index,
  question,
  type,
  answer,
  evaluation,
  total
}: {
  index: number;
  question: string;
  type: string;
  answer: string;
  evaluation: QuestionEvaluation;
  total: number;
}) {
  return (
    <article className="question-result-card">
      <div className="question-result-card__header">
        <div>
          <span>{index + 1}. {type}</span>
          <h4>{question}</h4>
        </div>
        <div className="question-result-card__score">
          <strong>{evaluation.score}</strong>
          <small>{index + 1} / {total}</small>
        </div>
      </div>
      <div className="answer-review">
        <h5>내 답변</h5>
        <p>{answer}</p>
      </div>
      <div className="evaluation__content">
        <InfoBlock title="잘 이해한 부분" items={evaluation.understood} />
        <InfoBlock title="부족한 부분" items={evaluation.missing} />
        <InfoBlock title="잘못 설명한 부분" items={evaluation.incorrect.length ? evaluation.incorrect : ["명확한 오류는 감지되지 않았습니다."]} />
        <InfoBlock title="다시 볼 코드" items={evaluation.reviewCode} />
        <article className="wide">
          <h3>더 좋은 답변 예시</h3>
          <p>{evaluation.betterAnswer}</p>
        </article>
        <article className="wide">
          <h3>후속 질문</h3>
          <p>{evaluation.followUpQuestion}</p>
        </article>
      </div>
    </article>
  );
}

function InfoBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <article className="info-block">
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

function FeedbackCta() {
  return (
    <section className="feedback-cta result-feedback-cta">
      <div>
        <p className="section-label">피드백 요청</p>
        <h2>Commit Mode 결과가 변경 이해에 도움이 되었나요?</h2>
        <p>커밋 분석 정확도, 질문 품질, 리포트에서 아쉬웠던 점을 알려주세요.</p>
      </div>
      <a href={FEEDBACK_URL} target="_blank" rel="noreferrer" onClick={() => track("feedback_clicked", { source: "commit_result_bottom" })}>
        피드백 남기기
      </a>
    </section>
  );
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
