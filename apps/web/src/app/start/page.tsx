"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { track } from "@vercel/analytics";
import { DEFAULT_QUESTION_TYPES, saveAnalysisSetup } from "@/lib/analysis-session";
import { effectiveRemaining, formatResetTime, type QuotaStatus } from "@/lib/quota";
import { AuthButton } from "../auth-button";

type StartMode = "project" | "commit";

const MODE_GUIDES = {
  project: {
    label: "Project Mode",
    title: "전체 프로젝트 구조를 이해하고 있는지 확인합니다.",
    description: "저장소 전체를 분석해 요청 흐름, 데이터 흐름, 변경 영향도 질문을 생성합니다.",
    placeholder: "https://github.com/username/project",
    inputLabel: "Public GitHub repository URL",
    button: "프로젝트 테스트 시작 →"
  },
  commit: {
    label: "Commit Mode",
    title: "이번 변경을 설명할 수 있는지 확인합니다.",
    description: "특정 커밋 diff를 분석해 변경 의도, 영향 범위, 테스트 리스크 질문을 생성합니다.",
    placeholder: "https://github.com/username/project/commit/abc123",
    inputLabel: "Public GitHub commit URL",
    button: "커밋 테스트 시작 →"
  }
} satisfies Record<StartMode, {
  label: string;
  title: string;
  description: string;
  placeholder: string;
  inputLabel: string;
  button: string;
}>;

export default function StartPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [mode, setMode] = useState<StartMode>("project");
  const [url, setUrl] = useState("");
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [quotaError, setQuotaError] = useState("");
  const guide = MODE_GUIDES[mode];
  const analysisRemaining = effectiveRemaining(quota?.analysis);
  const isQuotaExhausted = analysisRemaining !== null && analysisRemaining <= 0;

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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;

    if (!session?.user?.githubId) {
      track("login_required", { source: "start", mode });
      signIn("github");
      return;
    }
    if (isQuotaExhausted) return;

    if (mode === "commit") {
      track("commit_submitted", { source: "start" });
      router.push(`/commit/analyzing?url=${encodeURIComponent(trimmedUrl)}`);
      return;
    }

    track("repo_submitted", { source: "start" });
    saveAnalysisSetup({
      url: trimmedUrl,
      focus: "balanced",
      questionLevel: "standard",
      questionTypes: DEFAULT_QUESTION_TYPES,
      questionTargets: ""
    });
    router.push("/setup");
  }

  function selectMode(nextMode: StartMode) {
    setMode(nextMode);
    track(nextMode === "commit" ? "commit_mode_selected" : "project_mode_selected", { source: "start" });
  }

  return (
    <main>
      <SiteNav />
      <section className="start-page">
        <div className="start-page__header">
          <p className="section-label">시작하기</p>
          <h1>무엇을 기준으로 코드 이해도를 테스트할까요?</h1>
          <p>전체 저장소를 볼 수도 있고, 특정 커밋 하나만 골라 변경 내용을 검증할 수도 있습니다.</p>
        </div>

        <div className="start-layout">
          <section className="start-onboarding">
            <ModeCard
              mode="project"
              selected={mode}
              title="Project Mode"
              description="포트폴리오, MVP, 새 코드베이스처럼 전체 구조를 설명해야 할 때 사용합니다."
              meta="질문 5개 · 구조/흐름/영향도"
              onSelect={selectMode}
            />
            <ModeCard
              mode="commit"
              selected={mode}
              title="Commit Mode"
              description="실무 코드리뷰처럼 이번 변경의 의도와 영향 범위를 설명해야 할 때 사용합니다."
              meta="질문 4개 · 변경 의도/리스크"
              onSelect={selectMode}
            />
          </section>

          <form className="start-form" onSubmit={handleSubmit}>
            <div>
              <p className="section-label">{guide.label}</p>
              <h2>{guide.title}</h2>
              <p>{guide.description}</p>
            </div>
            <label htmlFor="githubUrl">{guide.inputLabel}</label>
            <div className="repo-input-wrap">
              <span>github</span>
              <input
                id="githubUrl"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={guide.placeholder}
                autoFocus
              />
            </div>
            {mode === "commit" ? <CommitUrlHelp /> : <ProjectModeHelp />}
            <QuotaNotice quota={quota} error={quotaError} />
            <button className="primary-button" type="submit" disabled={!url.trim() || isQuotaExhausted}>
              {isQuotaExhausted ? "오늘 분석 가능 횟수를 모두 사용했습니다" : status === "authenticated" ? guide.button : "GitHub 로그인 후 시작 →"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
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

function ModeCard({
  mode,
  selected,
  title,
  description,
  meta,
  onSelect
}: {
  mode: StartMode;
  selected: StartMode;
  title: string;
  description: string;
  meta: string;
  onSelect: (mode: StartMode) => void;
}) {
  return (
    <button className={selected === mode ? "start-mode-card is-selected" : "start-mode-card"} type="button" onClick={() => onSelect(mode)}>
      <span>{title}</span>
      <strong>{description}</strong>
      <small>{meta}</small>
    </button>
  );
}

function ProjectModeHelp() {
  return (
    <div className="start-help">
      <strong>Project Mode는 이렇게 진행됩니다.</strong>
      <ol>
        <li>public repository URL을 입력합니다.</li>
        <li>분석 관점, 난이도, 질문 유형을 선택합니다.</li>
        <li>질문에 답변하면 코드 근거 기반 리포트를 확인합니다.</li>
      </ol>
    </div>
  );
}

function CommitUrlHelp() {
  return (
    <div className="start-help">
      <strong>Commit URL은 어디서 가져오나요?</strong>
      <ol>
        <li>GitHub 저장소에서 Commits를 엽니다.</li>
        <li>분석하고 싶은 커밋을 클릭합니다.</li>
        <li>주소창의 /commit/sha URL을 복사합니다.</li>
      </ol>
    </div>
  );
}

function SiteNav() {
  return (
    <nav className="site-nav">
      <div className="site-nav__inner">
        <button className="brand brand-button" type="button" onClick={() => window.location.assign("/")}>
          <span className="brand__mark">KYC</span>
          <span>KnowYourCode</span>
        </button>
        <AuthButton />
      </div>
    </nav>
  );
}
