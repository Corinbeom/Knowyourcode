"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AnalysisFocus, AnalysisResult, EvaluationResult, UnderstandingQuestion } from "@/lib/types";

type AnalyzeState = "idle" | "loading" | "ready" | "error";
type EvaluateState = "idle" | "loading" | "ready" | "error";

const ANALYSIS_STEPS = [
  {
    title: "저장소 구조 읽는 중",
    meta: "GitHub ZIP · file tree",
    description: "public repository에서 분석 가능한 파일 목록을 가져옵니다."
  },
  {
    title: "분석 대상 파일 고르는 중",
    meta: "filter · runtime files",
    description: "node_modules, build 산출물, 테스트 파일을 낮은 우선순위로 분리합니다."
  },
  {
    title: "기술 스택과 진입점 찾는 중",
    meta: "stack · entry points",
    description: "package.json, route, page, service, config 파일을 중심으로 구조를 봅니다."
  },
  {
    title: "코드 이해도 질문 생성 중",
    meta: "questions · code signals",
    description: "실제 파일명과 함수명을 근거로 프로젝트 맞춤 질문을 만듭니다."
  },
  {
    title: "프로젝트 리포트 정리 중",
    meta: "report · feedback ready",
    description: "요청 흐름, 데이터 흐름, 다시 봐야 할 파일을 요약합니다."
  }
];

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [analysisFocus, setAnalysisFocus] = useState<AnalysisFocus>("balanced");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>("");
  const [answer, setAnswer] = useState("");
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [analyzeState, setAnalyzeState] = useState<AnalyzeState>("idle");
  const [evaluateState, setEvaluateState] = useState<EvaluateState>("idle");
  const [analysisStep, setAnalysisStep] = useState(0);
  const [error, setError] = useState("");
  const [evaluationError, setEvaluationError] = useState("");

  const selectedQuestion = useMemo(
    () => analysis?.questions.find((question) => question.id === selectedQuestionId) ?? null,
    [analysis, selectedQuestionId]
  );

  useEffect(() => {
    if (analyzeState !== "loading") return;

    setAnalysisStep(0);
    const interval = window.setInterval(() => {
      setAnalysisStep((step) => Math.min(step + 1, ANALYSIS_STEPS.length - 1));
    }, 1400);

    return () => window.clearInterval(interval);
  }, [analyzeState]);

  async function handleAnalyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAnalyzeState("loading");
    setAnalysisStep(0);
    setEvaluateState("idle");
    setError("");
    setEvaluationError("");
    setEvaluation(null);

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: repoUrl, focus: analysisFocus })
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
      <nav className="site-nav">
        <div className="site-nav__inner">
          <div className="brand">
            <span className="brand__mark">KYC</span>
            <span>KnowYourCode</span>
          </div>
          <div className="nav-meta">
            <span className="nav-dot" />
            Public repo analysis
            <span>Gemini 3.1 Flash Lite</span>
          </div>
        </div>
      </nav>
      <section className="hero">
        <div className="hero__inner">
          <div>
            <p className="eyebrow">AI Code Understanding · for developers</p>
            <h1>
              AI가 만든 코드,
              <br />
              <span className="gradient-text">설명할 수 있나요?</span>
            </h1>
            <p className="hero__copy">
              GitHub 저장소를 분석하고, 실제 파일과 흐름을 근거로
              코드 이해도 질문과 답변 피드백을 제공합니다. 내 코드가 정말 내 것인지
              확인해보세요.
            </p>
            <form className="repo-form" onSubmit={handleAnalyze}>
              <label htmlFor="repoUrl">Public GitHub repository URL</label>
              <fieldset className="focus-control">
                <legend>분석 관점</legend>
                <FocusOption
                  label="전체 균형"
                  description="프론트와 백엔드를 함께 봅니다."
                  value="balanced"
                  selected={analysisFocus}
                  onChange={setAnalysisFocus}
                />
                <FocusOption
                  label="프론트엔드 중심"
                  description="화면, 라우팅, 상태 흐름을 우선합니다."
                  value="frontend"
                  selected={analysisFocus}
                  onChange={setAnalysisFocus}
                />
                <FocusOption
                  label="백엔드 중심"
                  description="API, 서비스, 데이터 흐름을 우선합니다."
                  value="backend"
                  selected={analysisFocus}
                  onChange={setAnalysisFocus}
                />
              </fieldset>
              <div className="repo-form__row">
                <div className="repo-input-wrap">
                  <span>github</span>
                  <input
                    id="repoUrl"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/username/project"
                    disabled={analyzeState === "loading"}
                  />
                </div>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={analyzeState === "loading" || !repoUrl.trim()}
                >
                  {analyzeState === "loading" ? "분석 중" : "테스트 시작 →"}
                </button>
              </div>
            </form>
            <div className="hero__meta">
              <span>· Public repository만 지원</span>
              <span>· 무료 리포트 제공</span>
              <span>· 카드 등록 불필요</span>
            </div>
            <AnalysisProgress state={analyzeState} activeStep={analysisStep} />
            {analyzeState === "error" ? <p className="error">{error}</p> : null}
          </div>
          <HeroPreview />
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
              <p className="section-label">Your Answer</p>
              <h2>{selectedQuestion?.question ?? "질문을 선택해주세요."}</h2>
            </div>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="코드 파일명, 요청 흐름, 수정 영향 범위를 연결해서 답변해보세요."
              disabled={evaluateState === "loading"}
            />
            <div className="answer-actions">
              <span>답변은 코드 근거를 기반으로 평가됩니다.</span>
              <button type="submit" disabled={evaluateState === "loading" || !answer.trim()}>
                {evaluateState === "loading" ? "평가 중" : "답변 제출 →"}
              </button>
            </div>
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

function FocusOption({
  label,
  description,
  value,
  selected,
  onChange
}: {
  label: string;
  description: string;
  value: AnalysisFocus;
  selected: AnalysisFocus;
  onChange: (value: AnalysisFocus) => void;
}) {
  return (
    <label className={selected === value ? "focus-option is-selected" : "focus-option"}>
      <input
        type="radio"
        name="analysisFocus"
        value={value}
        checked={selected === value}
        onChange={() => onChange(value)}
      />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function AnalysisProgress({
  state,
  activeStep
}: {
  state: AnalyzeState;
  activeStep: number;
}) {
  if (state === "idle") return null;

  const isDone = state === "ready";
  const isError = state === "error";
  const visibleStep = isDone ? ANALYSIS_STEPS.length : activeStep;

  return (
    <section className="analysis-progress">
      <div className="analysis-progress__header">
        <div>
          <p className="section-label">분석 진행 상황</p>
          <h2>
            {isDone
              ? "분석이 완료됐습니다"
              : isError
                ? "분석을 완료하지 못했습니다"
                : "저장소를 읽고 있습니다"}
          </h2>
        </div>
        <span>
          {Math.min(visibleStep + (isDone ? 0 : 1), ANALYSIS_STEPS.length)} / {ANALYSIS_STEPS.length}
        </span>
      </div>
      <ol>
        {ANALYSIS_STEPS.map((step, index) => {
          const status = isDone || index < activeStep ? "done" : index === activeStep && !isError ? "active" : "pending";
          return (
            <li className={`analysis-step is-${status}`} key={step.title}>
              <span className="analysis-step__dot">{status === "done" ? "✓" : status === "active" ? "…" : ""}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{status === "pending" ? "대기 중" : step.description}</p>
              </div>
              <small>{status === "pending" ? "queued" : step.meta}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function HeroPreview() {
  return (
    <aside className="preview-card">
      <div className="preview-card__chrome">
        <div className="window-dots">
          <span />
          <span />
          <span />
        </div>
        <span>report / repo-analysis.json</span>
        <span>v1</span>
      </div>
      <div className="preview-card__body">
        <div className="preview-score">
          <small>Understanding Score</small>
          <strong>72</strong>
          <div className="progress-track">
            <div className="progress-fill" />
          </div>
          <div className="metric-list">
            <div>
              <span>Complexity</span>
              <span>Medium</span>
            </div>
            <div>
              <span>Interview Risk</span>
              <span>High</span>
            </div>
            <div>
              <span>Evidence</span>
              <span>Files</span>
            </div>
          </div>
        </div>
        <div className="preview-panel">
          <small>Weak Areas</small>
          <div className="tag-list">
            <span className="tag danger">Auth Flow</span>
            <span className="tag warning">Test Coverage</span>
            <span className="tag warning">Data Flow</span>
          </div>
          <p className="preview-question">
            로그인 요청이 어떤 API route와 service 파일을 거쳐 처리되는지 설명해보세요.
          </p>
        </div>
      </div>
    </aside>
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
      <div className="report-grid">
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

function formatFocusLabel(focus: AnalysisFocus): string {
  if (focus === "frontend") return "프론트엔드 중심";
  if (focus === "backend") return "백엔드 중심";
  return "전체 균형";
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
        <p className="section-label">Understanding Questions</p>
        <h2>질문 5개</h2>
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
          <p className="section-label">Related Files</p>
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
