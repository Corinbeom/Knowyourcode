"use client";

import { FormEvent, useMemo, useState } from "react";
import type { AnalysisResult, EvaluationResult, UnderstandingQuestion } from "@/lib/types";

type AnalyzeState = "idle" | "loading" | "ready" | "error";
type EvaluateState = "idle" | "loading" | "ready" | "error";

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>("");
  const [answer, setAnswer] = useState("");
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [analyzeState, setAnalyzeState] = useState<AnalyzeState>("idle");
  const [evaluateState, setEvaluateState] = useState<EvaluateState>("idle");
  const [error, setError] = useState("");
  const [evaluationError, setEvaluationError] = useState("");

  const selectedQuestion = useMemo(
    () => analysis?.questions.find((question) => question.id === selectedQuestionId) ?? null,
    [analysis, selectedQuestionId]
  );

  async function handleAnalyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAnalyzeState("loading");
    setEvaluateState("idle");
    setError("");
    setEvaluationError("");
    setEvaluation(null);

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: repoUrl })
    });
    const data = await response.json();

    if (!response.ok) {
      setAnalyzeState("error");
      setError(data.error ?? "분석에 실패했습니다.");
      return;
    }

    setAnalysis(data.analysis);
    setSelectedQuestionId(data.analysis.questions[0]?.id ?? "");
    setAnswer("");
    setAnalyzeState("ready");
  }

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

    if (!response.ok) {
      setEvaluateState("error");
      setEvaluationError(data.error ?? "평가에 실패했습니다.");
      return;
    }

    setEvaluation(data.evaluation);
    setEvaluateState("ready");
  }

  return (
    <main>
      <section className="hero">
        <div className="hero__inner">
          <p className="eyebrow">AI 코드 이해도 테스트</p>
          <h1>KnowYourCode</h1>
          <p className="hero__copy">
            GitHub 저장소를 입력하면 프로젝트 구조를 분석하고, 질문과 피드백으로
            내가 코드를 설명할 수 있는지 확인합니다.
          </p>
          <form className="repo-form" onSubmit={handleAnalyze}>
            <label htmlFor="repoUrl">Public GitHub repository URL</label>
            <div className="repo-form__row">
              <input
                id="repoUrl"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/vercel/next.js"
                disabled={analyzeState === "loading"}
              />
              <button type="submit" disabled={analyzeState === "loading" || !repoUrl.trim()}>
                {analyzeState === "loading" ? "분석 중" : "분석하기"}
              </button>
            </div>
          </form>
          {analyzeState === "error" ? <p className="error">{error}</p> : null}
        </div>
      </section>

      {analysis ? (
        <section className="workspace">
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
          <form className="answer-panel" onSubmit={handleEvaluate}>
            <div>
              <p className="section-label">답변 평가</p>
              <h2>{selectedQuestion?.question ?? "질문을 선택해주세요."}</h2>
            </div>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="코드 파일명, 요청 흐름, 수정 영향 범위를 연결해서 답변해보세요."
              disabled={evaluateState === "loading"}
            />
            <button type="submit" disabled={evaluateState === "loading" || !answer.trim()}>
              {evaluateState === "loading" ? "평가 중" : "답변 평가하기"}
            </button>
            {evaluateState === "error" ? <p className="error">{evaluationError}</p> : null}
          </form>
          {evaluation ? <EvaluationView evaluation={evaluation} /> : null}
          <PricingCta />
        </section>
      ) : (
        <section className="empty-state">
          <div>
            <p className="section-label">MVP 지원 범위</p>
            <h2>JavaScript/TypeScript public repo부터 정확하게 봅니다.</h2>
          </div>
          <ul>
            <li>README, package.json, src/app/pages/lib/api 계열 파일 분석</li>
            <li>기본 리포트와 이해도 질문 5개 생성</li>
            <li>답변 1회에 대해 코드 근거 기반 피드백 제공</li>
          </ul>
        </section>
      )}
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
          <div className="score-chip">난이도 {report.difficulty}</div>
          <div className={analysis.ai.used ? "ai-chip is-live" : "ai-chip"}>
            {analysis.ai.used ? `${analysis.ai.provider} 분석` : "기본 분석"}
          </div>
        </div>
      </div>
      {!analysis.ai.used && analysis.ai.reason ? (
        <p className="notice">{analysis.ai.reason}</p>
      ) : null}
      <p className="summary">{report.oneLineSummary}</p>
      <div className="grid">
        <InfoBlock title="기술 스택" items={report.techStack} />
        <InfoBlock title="핵심 기능" items={report.coreFeatures} />
        <InfoBlock title="주요 구조" items={report.folderStructure.slice(0, 8)} />
        <InfoBlock title="위험 질문" items={report.riskyQuestions} />
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
        <h3>다시 봐야 할 핵심 파일</h3>
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
      </div>
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
    </section>
  );
}

function EvaluationView({ evaluation }: { evaluation: EvaluationResult }) {
  return (
    <section className="evaluation">
      <div className="evaluation__score">
        <span>{evaluation.score}</span>
        <p>점수</p>
      </div>
      <div className="evaluation__content">
        <InfoBlock title="잘 이해한 부분" items={evaluation.understood} />
        <InfoBlock title="부족한 부분" items={evaluation.missing} />
        <InfoBlock title="잘못 설명한 부분" items={evaluation.incorrect.length ? evaluation.incorrect : ["명확한 오류는 감지되지 않았습니다."]} />
        <InfoBlock title="관련 파일" items={evaluation.relatedFiles} />
        <article className="wide">
          <h3>더 좋은 답변 예시</h3>
          <p>{evaluation.betterAnswer}</p>
        </article>
        <article className="wide">
          <h3>후속 질문</h3>
          <p>{evaluation.followUpQuestion}</p>
        </article>
      </div>
    </section>
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
