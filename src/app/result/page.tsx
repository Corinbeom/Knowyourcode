"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { loadAnalysisResult } from "@/lib/analysis-session";
import type { AnalysisFocus, AnalysisResult, EvaluationResult, QuestionLevel, QuestionType, UnderstandingQuestion } from "@/lib/types";

type EvaluateState = "idle" | "loading" | "ready" | "error";
type UsageLimit = {
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds?: number;
};

const ALL_QUESTION_TYPES: QuestionType[] = ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"];

export default function ResultPage() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [answer, setAnswer] = useState("");
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [evaluateState, setEvaluateState] = useState<EvaluateState>("idle");
  const [evaluationError, setEvaluationError] = useState("");
  const [evaluateLimit, setEvaluateLimit] = useState<UsageLimit | undefined>();

  useEffect(() => {
    const stored = loadAnalysisResult();
    if (!stored) {
      router.replace("/");
      return;
    }
    setAnalysis(stored);
    setSelectedQuestionId(stored.questions[0]?.id ?? "");
  }, [router]);

  const selectedQuestion = useMemo(
    () => analysis?.questions.find((question) => question.id === selectedQuestionId) ?? null,
    [analysis, selectedQuestionId]
  );

  async function handleEvaluate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!analysis || !selectedQuestionId) return;

    setEvaluateState("loading");
    setEvaluationError("");
    setEvaluation(null);

    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysis, questionId: selectedQuestionId, answer })
    });
    const data = await response.json();
    setEvaluateLimit(data.limit ?? data.limits?.evaluate ?? evaluateLimit);

    if (!response.ok) {
      setEvaluateState("error");
      setEvaluationError(data.error ?? "평가에 실패했습니다.");
      return;
    }

    setEvaluation(data.evaluation);
    setEvaluateState("ready");
  }

  if (!analysis) return null;

  return (
    <main>
      <SiteNav />
      <section className="workspace result-workspace">
        <div className="result-actions">
          <button className="secondary-button" type="button" onClick={() => router.push("/")}>
            새 저장소 분석
          </button>
        </div>
        <ProjectReportView analysis={analysis} />
        <QuestionPanel
          questions={analysis.questions}
          selectedQuestionId={selectedQuestionId}
          onSelect={(id) => {
            setSelectedQuestionId(id);
            setEvaluation(null);
            setEvaluateState("idle");
          }}
        />
        <section className="practice-section">
          <form className="answer-panel" onSubmit={handleEvaluate}>
            <div>
              <p className="section-label">답변 작성</p>
              <h2>{selectedQuestion?.question ?? "질문을 선택해주세요."}</h2>
              <p className="section-description">파일명, 처리 흐름, 수정 영향 범위를 연결해서 설명해보세요.</p>
            </div>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="예: 로그인 요청은 authApi에서 시작해 AuthContext의 상태 갱신으로 이어지고..."
              maxLength={4000}
              disabled={evaluateState === "loading"}
            />
            <div className="answer-actions">
              <span>코드 근거를 기준으로 평가합니다. 남은 평가 {formatLimitText(evaluateLimit, "10회/시간")}</span>
              <button type="submit" disabled={evaluateState === "loading" || !answer.trim() || evaluateLimit?.remaining === 0}>
                {evaluateState === "loading" ? "평가 중" : "답변 제출 →"}
              </button>
            </div>
            <p className="usage-note">답변 최대 4,000자</p>
            {evaluateState === "loading" ? <EvaluationLoading /> : null}
            {evaluateState === "error" ? <p className="error">{evaluationError}</p> : null}
          </form>
          {evaluation ? <EvaluationView evaluation={evaluation} /> : null}
        </section>
        <PricingCta />
      </section>
    </main>
  );
}

function ProjectReportView({ analysis }: { analysis: AnalysisResult }) {
  const { report } = analysis;

  return (
    <section className="report">
      <div className="report__header">
        <div>
          <p className="section-label">프로젝트 리포트</p>
          <h2>{analysis.repo.owner}/{analysis.repo.repo}</h2>
        </div>
        <div className="report__badges">
          <div className="focus-chip">{formatFocusLabel(analysis.focus)}</div>
          <div className="level-chip">{formatQuestionLevelLabel(analysis.questionLevel)}</div>
          <div className="type-chip">{formatQuestionTypesLabel(analysis.questionTypes)}</div>
          {analysis.questionTargets.length ? <div className="target-chip">{analysis.questionTargets.join(", ")}</div> : null}
          <div className="score-chip">난이도 {report.difficulty}</div>
          <div className={analysis.ai.used ? "ai-chip is-live" : "ai-chip"}>
            {analysis.ai.used ? `${analysis.ai.provider} 분석` : "기본 분석"}
          </div>
        </div>
      </div>
      {!analysis.ai.used && analysis.ai.reason ? <p className="notice">{analysis.ai.reason}</p> : null}
      <p className="summary">{report.oneLineSummary}</p>
      <div className="report-section-heading">
        <h3>프로젝트 요약</h3>
        <p>저장소에서 먼저 확인해야 할 기술, 기능, 구조, 위험 질문입니다.</p>
      </div>
      <div className="report-grid">
        <InfoBlock title="기술 스택" items={report.techStack} />
        <InfoBlock title="핵심 기능" items={report.coreFeatures} />
        <InfoBlock title="주요 구조" items={report.folderStructure.slice(0, 8)} />
        <InfoBlock title="위험 질문" items={report.riskyQuestions} />
      </div>
      <div className="report-section-heading">
        <h3>흐름 분석</h3>
        <p>요청이 들어오고 데이터가 이동하는 큰 흐름입니다.</p>
      </div>
      <div className="flow-grid">
        <article>
          <h3>요청 흐름</h3>
          <p>{report.requestFlow}</p>
        </article>
        <article>
          <h3>데이터 흐름</h3>
          <p>{report.dataFlow}</p>
        </article>
      </div>
      <div className="file-list">
        <div className="report-section-heading">
          <h3>다시 봐야 할 핵심 파일</h3>
          <p>면접이나 코드 리뷰 전에 우선적으로 열어볼 파일입니다.</p>
        </div>
        {report.keyFiles.map((file) => (
          <article key={file.path}>
            <strong>{file.path}</strong>
            <p>{file.reason}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function QuestionPanel({
  questions,
  selectedQuestionId,
  onSelect
}: {
  questions: UnderstandingQuestion[];
  selectedQuestionId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="questions">
      <div>
        <p className="section-label">이해도 질문</p>
        <h2>질문 5개</h2>
        <p className="section-description">하나씩 선택해서 답변하고, 실제 코드 기준으로 피드백을 받아보세요.</p>
      </div>
      <div className="question-layout">
        <div className="question-list">
          {questions.map((question) => (
            <button
              type="button"
              className={question.id === selectedQuestionId ? "question is-active" : "question"}
              key={question.id}
              onClick={() => onSelect(question.id)}
            >
              <span>{question.type}</span>
              {question.question}
            </button>
          ))}
        </div>
        <aside className="related-panel surface-card">
          <p className="section-label">관련 파일</p>
          <ul>
            {(questions.find((question) => question.id === selectedQuestionId)?.relatedFiles ?? []).map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </aside>
      </div>
    </section>
  );
}

function EvaluationView({ evaluation }: { evaluation: EvaluationResult }) {
  return (
    <section className="evaluation">
      <div className="evaluation__score">
        <span>{evaluation.score}</span>
        <p>점수</p>
        <small>{evaluation.scoreReason}</small>
      </div>
      <div className="evaluation__content">
        <InfoBlock title="잘 이해한 부분" items={evaluation.understood} />
        <InfoBlock title="부족한 부분" items={evaluation.missing} />
        <InfoBlock title="잘못 설명한 부분" items={evaluation.incorrect.length ? evaluation.incorrect : ["명확한 오류는 감지되지 않았습니다."]} />
        <InfoBlock title="관련 파일" items={evaluation.relatedFiles} />
        <InfoBlock title="다시 볼 코드" items={evaluation.reviewCode} />
        <article className="wide">
          <h3>더 좋은 답변 예시</h3>
          <p>{evaluation.betterAnswer}</p>
        </article>
        <article className="wide">
          <h3>면접 답변 방향</h3>
          <p>{evaluation.interviewAnswerDirection}</p>
        </article>
        <article className="wide">
          <h3>후속 질문</h3>
          <p>{evaluation.followUpQuestion}</p>
        </article>
      </div>
    </section>
  );
}

function EvaluationLoading() {
  return (
    <div className="evaluation-loading">
      <span className="evaluation-loading__spinner" aria-hidden="true" />
      <div>
        <strong>답변을 코드 근거와 대조하는 중입니다</strong>
        <p>관련 파일, 빠진 설명, 면접 답변 방향을 함께 정리하고 있습니다.</p>
      </div>
    </div>
  );
}

function PricingCta() {
  return (
    <section className="pricing">
      <article>
        <h3>Deep Report</h3>
        <p>심화 흐름 분석, 질문 30개, 피드백 10회를 제공하는 유료 리포트.</p>
        <button type="button">관심 있음</button>
      </article>
      <article>
        <h3>Interview Pack</h3>
        <p>면접 질문, 꼬리 질문, 1분/3분 프로젝트 설명 스크립트까지 확장.</p>
        <button type="button">면접 대비하기</button>
      </article>
      <article>
        <h3>Pro</h3>
        <p>월 3개 repo 심화 분석, 답변 피드백, private repo 지원 예정.</p>
        <button type="button">출시 알림</button>
      </article>
    </section>
  );
}

function InfoBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <article className="info-block">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

function formatFocusLabel(focus: AnalysisFocus): string {
  if (focus === "frontend") return "프론트엔드 중심";
  if (focus === "backend") return "백엔드 중심";
  return "전체 균형";
}

function formatQuestionLevelLabel(questionLevel: QuestionLevel): string {
  if (questionLevel === "basic") return "난이도 기초";
  if (questionLevel === "deep") return "난이도 심화";
  return "난이도 보통";
}

function formatQuestionTypesLabel(questionTypes: QuestionType[]): string {
  if (questionTypes.length === ALL_QUESTION_TYPES.length && ALL_QUESTION_TYPES.every((type) => questionTypes.includes(type))) {
    return "질문 유형 전체";
  }
  return questionTypes.join(", ");
}

function formatLimitText(limit: UsageLimit | undefined, fallback: string): string {
  if (!limit) return fallback;
  if (limit.remaining === 0) return `0/${limit.limit} · ${formatResetTime(limit.resetAt)} 후 초기화`;
  return `${limit.remaining}/${limit.limit}회 남음`;
}

function formatResetTime(resetAt: string): string {
  const resetDate = new Date(resetAt);
  if (Number.isNaN(resetDate.getTime())) return "잠시";

  const diffMinutes = Math.max(Math.ceil((resetDate.getTime() - Date.now()) / 60_000), 1);
  if (diffMinutes >= 60) return `${Math.ceil(diffMinutes / 60)}시간`;
  return `${diffMinutes}분`;
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
