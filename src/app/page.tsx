"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_QUESTION_TYPES, saveAnalysisSetup } from "@/lib/analysis-session";

export default function Home() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");

  function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repoUrl.trim()) return;

    saveAnalysisSetup({
      url: repoUrl.trim(),
      focus: "balanced",
      questionLevel: "standard",
      questionTypes: DEFAULT_QUESTION_TYPES,
      questionTargets: ""
    });
    router.push("/setup");
  }

  return (
    <main>
      <SiteNav />
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
              GitHub 저장소를 입력하면 프로젝트 구조를 분석하고, 실제 코드 근거로 이해도 질문과 답변 피드백을 제공합니다.
            </p>
            <form className="repo-form start-form" onSubmit={handleStart}>
              <label htmlFor="repoUrl">Public GitHub repository URL</label>
              <div className="repo-form__row">
                <div className="repo-input-wrap">
                  <span>github</span>
                  <input
                    id="repoUrl"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/username/project"
                  />
                </div>
                <button className="primary-button" type="submit" disabled={!repoUrl.trim()}>
                  시작하기 →
                </button>
              </div>
            </form>
            <div className="hero__meta">
              <span>· Public repository만 지원</span>
              <span>· 무료 리포트 제공</span>
              <span>· 카드 등록 불필요</span>
            </div>
          </div>
          <HeroPreview />
        </div>
      </section>
      <section className="empty-state">
        <div>
          <p className="section-label">MVP 지원 범위</p>
          <h2>URL 입력 후 분석 관점, 난이도, 질문 유형을 단계별로 선택합니다.</h2>
        </div>
        <ul>
          <li>README, 설정 파일, 주요 runtime source 분석</li>
          <li>기본 리포트와 이해도 질문 5개 생성</li>
          <li>답변 1회에 대해 코드 근거 기반 피드백 제공</li>
        </ul>
      </section>
    </main>
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
        <div className="nav-meta">
          <span className="nav-dot" />
          Public repo analysis
          <span>Gemini 3.1 Flash Lite</span>
        </div>
      </div>
    </nav>
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
          <p className="preview-question">로그인 요청이 어떤 API route와 service 파일을 거쳐 처리되는지 설명해보세요.</p>
        </div>
      </div>
    </aside>
  );
}
