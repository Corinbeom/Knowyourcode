"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { AuthButton } from "../auth-button";
import {
  DEFAULT_QUESTION_TYPES,
  type AnalysisSetup,
  loadAnalysisSetup,
  saveAnalysisSetup
} from "@/lib/analysis-session";
import { effectiveRemaining, formatResetTime, type QuotaStatus } from "@/lib/quota";
import type { AnalysisFocus, QuestionLevel, QuestionType } from "@/lib/types";

export default function SetupPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [setup, setSetup] = useState<AnalysisSetup | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [quotaError, setQuotaError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const analysisRemaining = effectiveRemaining(quota?.analysis);
  const isQuotaExhausted = analysisRemaining !== null && analysisRemaining <= 0;
  const isCheckingAuth = status === "loading";

  useEffect(() => {
    const stored = loadAnalysisSetup();
    if (!stored?.url) {
      router.replace("/");
      return;
    }
    setSetup(stored);
  }, [router]);

  useEffect(() => {
    if (!session?.user?.githubId) {
      setQuota(null);
      return;
    }

    let cancelled = false;
    fetch("/api/quota", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "사용량 정보를 가져오지 못했습니다.");
        if (!cancelled) {
          setQuota(data.limits);
          setQuotaError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setQuotaError(error instanceof Error ? error.message : "사용량 정보를 가져오지 못했습니다.");
      });

    return () => {
      cancelled = true;
    };
  }, [session?.user?.githubId]);

  if (!setup) return null;

  function updateSetup(next: Partial<AnalysisSetup>) {
    if (isSubmitting) return;
    setSetup((current) => current ? { ...current, ...next } : current);
  }

  function handleAnalyze() {
    if (isSubmitting || isCheckingAuth) return;
    if (!setup?.url) return;
    if (!session?.user?.githubId) {
      setIsSubmitting(true);
      signIn("github");
      return;
    }
    if (isQuotaExhausted) return;
    setIsSubmitting(true);
    saveAnalysisSetup(setup);
    router.push("/analyzing");
  }

  return (
    <main>
      <SiteNav />
      <section className="setup-page">
        <div className="setup-page__header">
          <p className="section-label">분석 설정</p>
          <h1>어떤 방식으로 코드를 검증할까요?</h1>
          <p>{setup.url}</p>
        </div>

        <section className="setup-section">
          <div>
            <p className="section-label">분석 관점</p>
            <h2>무엇을 중심으로 볼까요?</h2>
          </div>
          <fieldset className="focus-control">
            <legend>분석 관점</legend>
            <FocusOption
              label="전체 균형"
              description="프론트와 백엔드를 함께 봅니다."
              value="balanced"
              selected={setup.focus}
              onChange={(focus) => updateSetup({ focus })}
            />
            <FocusOption
              label="프론트엔드 중심"
              description="화면, 라우팅, 상태 흐름을 우선합니다."
              value="frontend"
              selected={setup.focus}
              onChange={(focus) => updateSetup({ focus })}
            />
            <FocusOption
              label="백엔드 중심"
              description="API, 서비스, 데이터 흐름을 우선합니다."
              value="backend"
              selected={setup.focus}
              onChange={(focus) => updateSetup({ focus })}
            />
          </fieldset>
        </section>

        <section className="setup-section">
          <div>
            <p className="section-label">질문 난이도</p>
            <h2>어느 정도 난이도로 물어볼까요?</h2>
          </div>
          <fieldset className="level-control">
            <legend>질문 난이도</legend>
            <LevelOption
              label="기초"
              description="파일 역할과 기본 흐름부터 봅니다."
              value="basic"
              selected={setup.questionLevel}
              onChange={(questionLevel) => updateSetup({ questionLevel })}
            />
            <LevelOption
              label="보통"
              description="코드 흐름과 수정 영향을 함께 봅니다."
              value="standard"
              selected={setup.questionLevel}
              onChange={(questionLevel) => updateSetup({ questionLevel })}
            />
            <LevelOption
              label="심화"
              description="설계 의도와 운영 리스크까지 묻습니다."
              value="deep"
              selected={setup.questionLevel}
              onChange={(questionLevel) => updateSetup({ questionLevel })}
            />
          </fieldset>
        </section>

        <section className="setup-section">
          <div>
            <p className="section-label">질문 유형</p>
            <h2>어떤 질문을 받고 싶나요?</h2>
          </div>
          <QuestionTypeSelector
            selected={setup.questionTypes}
            onSelectAll={() => updateSetup({ questionTypes: DEFAULT_QUESTION_TYPES })}
            onToggle={(type) => updateSetup({ questionTypes: toggleQuestionType(setup.questionTypes, type) })}
          />
        </section>

        <section className="setup-section">
          <div>
            <p className="section-label">관심 기능</p>
            <h2>집중해서 보고 싶은 기능이 있나요?</h2>
          </div>
          <div className="target-field">
            <label htmlFor="questionTargets">관심 기능</label>
            <input
              id="questionTargets"
              value={setup.questionTargets}
              onChange={(event) => updateSetup({ questionTargets: event.target.value })}
              placeholder="예: 로그인, AI 면접, 지원 현황"
            />
            <span>비워두면 저장소 전체 기능을 기준으로 질문을 만듭니다.</span>
          </div>
        </section>

        <div className="setup-actions">
          <QuotaNotice quota={quota} error={quotaError} />
          <button className="secondary-button" type="button" onClick={() => router.push("/")} disabled={isSubmitting}>
            저장소 다시 입력
          </button>
          <button className="primary-button" type="button" onClick={handleAnalyze} disabled={isQuotaExhausted || isCheckingAuth || isSubmitting}>
            {buttonLabel({ isQuotaExhausted, isCheckingAuth, isSubmitting, isAuthenticated: status === "authenticated" })}
          </button>
        </div>
      </section>
    </main>
  );
}

function buttonLabel({
  isQuotaExhausted,
  isCheckingAuth,
  isSubmitting,
  isAuthenticated
}: {
  isQuotaExhausted: boolean;
  isCheckingAuth: boolean;
  isSubmitting: boolean;
  isAuthenticated: boolean;
}): string {
  if (isQuotaExhausted) return "오늘 분석 가능 횟수를 모두 사용했습니다";
  if (isCheckingAuth) return "로그인 상태 확인 중...";
  if (isSubmitting) return isAuthenticated ? "분석 준비 중..." : "GitHub 로그인으로 이동 중...";
  return isAuthenticated ? "분석 시작 →" : "GitHub 로그인 후 분석 시작 →";
}

function QuotaNotice({ quota, error }: { quota: QuotaStatus | null; error: string }) {
  if (error) return <p className="quota-notice is-warning">{error}</p>;
  const remaining = effectiveRemaining(quota?.analysis);
  if (remaining === null) {
    return <p className="quota-notice">GitHub 로그인 후 오늘 남은 분석 횟수를 확인할 수 있습니다.</p>;
  }

  return (
    <p className={remaining <= 0 ? "quota-notice is-warning" : "quota-notice"}>
      오늘 남은 분석 {remaining}회 · {formatResetTime(quota?.analysis.user.resetAt)} 초기화
    </p>
  );
}

function toggleQuestionType(current: QuestionType[], type: QuestionType): QuestionType[] {
  if (current.length === DEFAULT_QUESTION_TYPES.length) return [type];

  const withoutType = current.filter((item) => item !== type);
  if (withoutType.length !== current.length) return withoutType.length ? withoutType : DEFAULT_QUESTION_TYPES;
  return [...current, type];
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
      <input type="radio" name="analysisFocus" value={value} checked={selected === value} onChange={() => onChange(value)} />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function LevelOption({
  label,
  description,
  value,
  selected,
  onChange
}: {
  label: string;
  description: string;
  value: QuestionLevel;
  selected: QuestionLevel;
  onChange: (value: QuestionLevel) => void;
}) {
  return (
    <label className={selected === value ? "focus-option is-selected" : "focus-option"}>
      <input type="radio" name="questionLevel" value={value} checked={selected === value} onChange={() => onChange(value)} />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function QuestionTypeSelector({
  selected,
  onSelectAll,
  onToggle
}: {
  selected: QuestionType[];
  onSelectAll: () => void;
  onToggle: (type: QuestionType) => void;
}) {
  const isAllSelected = selected.length === DEFAULT_QUESTION_TYPES.length;
  return (
    <fieldset className="question-type-control">
      <legend>질문 유형</legend>
      <button type="button" className={isAllSelected ? "question-type-chip is-selected" : "question-type-chip"} onClick={onSelectAll}>
        전체
      </button>
      {DEFAULT_QUESTION_TYPES.map((type) => (
        <button
          type="button"
          className={selected.includes(type) && !isAllSelected ? "question-type-chip is-selected" : "question-type-chip"}
          key={type}
          onClick={() => onToggle(type)}
        >
          {type}
        </button>
      ))}
    </fieldset>
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
        <AuthButton />
      </div>
    </nav>
  );
}
