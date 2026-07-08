"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import { loadAnalysisSetup, saveAnalysisResult, type AnalysisSetup } from "@/lib/analysis-session";

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
    description: "설정 파일, route, service, component 파일을 중심으로 구조를 봅니다."
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

export default function AnalyzingPage() {
  const router = useRouter();
  const startedRef = useRef(false);
  const [setup, setSetup] = useState<AnalysisSetup | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = loadAnalysisSetup();
    if (!stored?.url) {
      router.replace("/");
      return;
    }
    setSetup(stored);
  }, [router]);

  useEffect(() => {
    if (!setup || startedRef.current) return;
    startedRef.current = true;

    const interval = window.setInterval(() => {
      setActiveStep((step) => Math.min(step + 1, ANALYSIS_STEPS.length - 1));
    }, 1400);

    async function analyze() {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: setup?.url,
          focus: setup?.focus,
          questionLevel: setup?.questionLevel,
          questionTypes: setup?.questionTypes,
          questionTargets: setup?.questionTargets
        })
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "분석에 실패했습니다.");
        window.clearInterval(interval);
        return;
      }

      saveAnalysisResult(data.analysis);
      track("analysis_completed", {
        focus: setup?.focus ?? "balanced",
        questionLevel: setup?.questionLevel ?? "standard"
      });
      window.clearInterval(interval);
      setActiveStep(ANALYSIS_STEPS.length - 1);
      setIsComplete(true);
      window.setTimeout(() => {
        router.push("/quiz");
      }, 450);
    }

    analyze().catch((caughtError) => {
      setError(caughtError instanceof Error ? caughtError.message : "분석 중 오류가 발생했습니다.");
      window.clearInterval(interval);
    });

    return () => window.clearInterval(interval);
  }, [router, setup]);

  if (!setup) return null;

  return (
    <main>
      <SiteNav />
      <section className="analysis-page">
        <div className="analysis-stage__summary">
          <div className="analysis-orbit" aria-hidden="true">
            <span />
          </div>
          <div>
            <p className="section-label">분석 설정</p>
            <h1>{setup.url}</h1>
            <div className="summary-chips">
              <span>{formatFocusLabel(setup.focus)}</span>
              <span>{formatQuestionLevelLabel(setup.questionLevel)}</span>
              <span>{formatQuestionTypesLabel(setup.questionTypes)}</span>
              <span>{setup.questionTargets.trim() || "전체 기능"}</span>
            </div>
          </div>
        </div>
        <AnalysisProgress activeStep={activeStep} isComplete={isComplete} isError={Boolean(error)} />
        {error ? (
          <div className="analysis-error">
            <p className="error">{error}</p>
            <div className="analysis-error__actions">
              <button className="primary-button" type="button" onClick={() => window.location.reload()}>
                다시 시도
              </button>
              <button className="secondary-button" type="button" onClick={() => router.push("/setup")}>
                설정으로 돌아가기
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function AnalysisProgress({ activeStep, isComplete, isError }: { activeStep: number; isComplete: boolean; isError: boolean }) {
  const isWaitingForApi = !isComplete && !isError && activeStep === ANALYSIS_STEPS.length - 1;

  return (
    <section className="analysis-progress">
      <div className="analysis-progress__header">
        <div>
          <p className="section-label">분석 진행 상황</p>
          <h2>{isError ? "분석을 완료하지 못했습니다" : isComplete ? "분석이 완료되었습니다" : isWaitingForApi ? "마지막 리포트를 생성하는 중입니다" : "저장소를 읽고 있습니다"}</h2>
          {isWaitingForApi ? (
            <p>저장소 크기와 GitHub 응답 속도에 따라 1분 이상 걸릴 수 있습니다.</p>
          ) : null}
        </div>
        <span>{Math.min(activeStep + 1, ANALYSIS_STEPS.length)} / {ANALYSIS_STEPS.length}</span>
      </div>
      <ol>
        {ANALYSIS_STEPS.map((step, index) => {
          const status = isComplete || index < activeStep ? "done" : index === activeStep && !isError ? "active" : "pending";
          return (
            <li className={`analysis-step is-${status}`} key={step.title}>
              <span className="analysis-step__dot">{status === "done" ? "✓" : status === "active" ? "…" : ""}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{status === "pending" ? "대기 중" : index === ANALYSIS_STEPS.length - 1 && isWaitingForApi ? "질문과 코드 근거를 묶어 최종 리포트를 정리하고 있습니다." : step.description}</p>
              </div>
              <small>{status === "pending" ? "queued" : step.meta}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function formatFocusLabel(focus: AnalysisSetup["focus"]): string {
  if (focus === "frontend") return "프론트엔드 중심";
  if (focus === "backend") return "백엔드 중심";
  return "전체 균형";
}

function formatQuestionLevelLabel(questionLevel: AnalysisSetup["questionLevel"]): string {
  if (questionLevel === "basic") return "난이도 기초";
  if (questionLevel === "deep") return "난이도 심화";
  return "난이도 보통";
}

function formatQuestionTypesLabel(questionTypes: AnalysisSetup["questionTypes"]): string {
  if (questionTypes.length === 5) return "질문 유형 전체";
  return questionTypes.join(", ");
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
