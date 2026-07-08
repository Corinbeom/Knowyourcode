"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { track } from "@vercel/analytics";
import { saveCommitAnalysisResult } from "@/lib/analysis-session";

const ANALYSIS_STEPS = [
  ["커밋 diff 읽는 중", "GitHub commit metadata와 변경 파일을 가져옵니다."],
  ["변경 파일 정리 중", "추가, 삭제, rename, patch 제공 여부를 확인합니다."],
  ["변경 의도 추론 중", "커밋 메시지와 diff를 함께 읽어 핵심 의도를 정리합니다."],
  ["이해도 질문 생성 중", "변경 영향과 테스트 리스크를 확인할 질문을 만듭니다."]
];

export default function CommitAnalyzingPage() {
  return (
    <Suspense fallback={null}>
      <CommitAnalyzingContent />
    </Suspense>
  );
}

function CommitAnalyzingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const startedRef = useRef(false);
  const activeStepRef = useRef(0);
  const url = searchParams.get("url") ?? "";
  const [activeStep, setActiveStep] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState("");
  const isWaitingForApi = !isComplete && !error && activeStep === ANALYSIS_STEPS.length - 1;

  useEffect(() => {
    if (!url) {
      router.replace("/");
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;

    const interval = window.setInterval(() => {
      setActiveStep((step) => {
        const nextStep = Math.min(step + 1, ANALYSIS_STEPS.length - 1);
        activeStepRef.current = nextStep;
        return nextStep;
      });
    }, 1300);

    async function analyze() {
      const response = await fetch("/api/analyze-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "커밋 분석에 실패했습니다.");
        window.clearInterval(interval);
        return;
      }

      saveCommitAnalysisResult(data.analysis);
      track("commit_analysis_completed", {
        fileCount: data.analysis?.fileCount ?? 0
      });
      window.clearInterval(interval);
      await playCompletionSteps();
      setIsComplete(true);
      window.setTimeout(() => {
        router.push("/commit/quiz");
      }, 700);
    }

    analyze().catch((caughtError) => {
      setError(caughtError instanceof Error ? caughtError.message : "커밋 분석 중 오류가 발생했습니다.");
      window.clearInterval(interval);
    });

    return () => window.clearInterval(interval);
  }, [router, url]);

  async function playCompletionSteps() {
    for (let index = activeStepRef.current + 1; index < ANALYSIS_STEPS.length; index += 1) {
      await wait(450);
      activeStepRef.current = index;
      setActiveStep(index);
    }
  }

  return (
    <main>
      <SiteNav />
      <section className="analysis-page">
        <div className="analysis-stage__summary">
          <div className="analysis-orbit" aria-hidden="true">
            <span />
          </div>
          <div>
            <p className="section-label">Commit Mode</p>
            <h1>{url}</h1>
            <div className="summary-chips">
              <span>커밋 단위 분석</span>
              <span>질문 4개</span>
              <span>변경 영향도</span>
            </div>
          </div>
        </div>
        <section className="analysis-progress">
          <div className="analysis-progress__header">
            <div>
              <p className="section-label">분석 진행 상황</p>
              <h2>{error ? "커밋 분석을 완료하지 못했습니다" : isComplete ? "커밋 분석이 완료되었습니다" : isWaitingForApi ? "변경 코드 근거를 정리하는 중입니다" : "변경 사항을 읽고 있습니다"}</h2>
              {isWaitingForApi ? (
                <p>커밋 diff가 크거나 LLM 응답이 늦으면 잠시 더 걸릴 수 있습니다.</p>
              ) : null}
            </div>
            <span>{Math.min(activeStep + 1, ANALYSIS_STEPS.length)} / {ANALYSIS_STEPS.length}</span>
          </div>
          <ol>
            {ANALYSIS_STEPS.map(([title, description], index) => {
              const status = isComplete || index < activeStep ? "done" : index === activeStep && !error ? "active" : "pending";
              return (
                <li className={`analysis-step is-${status}`} key={title}>
                  <span className="analysis-step__dot">{status === "done" ? "✓" : status === "active" ? "…" : ""}</span>
                  <div>
                    <strong>{title}</strong>
                    <p>{status === "pending" ? "대기 중" : index === ANALYSIS_STEPS.length - 1 && isWaitingForApi ? "변경 의도, 영향 범위, 테스트 리스크를 질문으로 묶고 있습니다." : description}</p>
                  </div>
                  <small>{status === "pending" ? "queued" : "commit diff"}</small>
                </li>
              );
            })}
          </ol>
        </section>
        {error ? (
          <div className="analysis-error">
            <p className="error">{error}</p>
            <div className="analysis-error__actions">
              <button className="primary-button" type="button" onClick={() => window.location.reload()}>
                다시 시도
              </button>
              <button className="secondary-button" type="button" onClick={() => router.push("/")}>
                처음으로 돌아가기
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
