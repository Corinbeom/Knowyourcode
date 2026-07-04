"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_QUESTION_TYPES,
  type AnalysisSetup,
  loadAnalysisSetup,
  saveAnalysisSetup
} from "@/lib/analysis-session";
import type { AnalysisFocus, QuestionLevel, QuestionType } from "@/lib/types";

export default function SetupPage() {
  const router = useRouter();
  const [setup, setSetup] = useState<AnalysisSetup | null>(null);

  useEffect(() => {
    const stored = loadAnalysisSetup();
    if (!stored?.url) {
      router.replace("/");
      return;
    }
    setSetup(stored);
  }, [router]);

  if (!setup) return null;

  function updateSetup(next: Partial<AnalysisSetup>) {
    setSetup((current) => current ? { ...current, ...next } : current);
  }

  function handleAnalyze() {
    if (!setup?.url) return;
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
          <button className="secondary-button" type="button" onClick={() => router.push("/")}>
            저장소 다시 입력
          </button>
          <button className="primary-button" type="button" onClick={handleAnalyze}>
            분석 시작 →
          </button>
        </div>
      </section>
    </main>
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
      </div>
    </nav>
  );
}
