"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import { TallyFeedbackButton } from "./tally-feedback-button";

const CORE_QUESTIONS = [
  "사용자의 요청은 어떤 파일들을 거쳐 처리되나요?",
  "데이터는 어디서 생성되고, 어디서 검증되고, 어디에 저장되나요?",
  "특정 기능을 수정하면 어떤 모듈에 영향이 생기나요?",
  "에러가 발생하면 어느 계층부터 확인해야 하나요?",
  "AI가 작성한 코드가 기존 구조와 맞게 들어간 건가요?",
  "면접에서 이 프로젝트를 기술적으로 설명할 수 있나요?"
];

const PAIN_POINTS = [
  "이 코드가 왜 이렇게 동작하는지 설명해야 할 때",
  "수정한 코드가 어디까지 영향을 주는지 판단해야 할 때",
  "AI가 제안한 해결책이 맞는지 검증해야 할 때",
  "면접이나 코드리뷰에서 프로젝트 구조를 설명해야 할 때",
  "장애가 났는데 어느 흐름부터 봐야 할지 찾아야 할 때"
];

const HOW_IT_WORKS = [
  ["GitHub 저장소 입력", "public GitHub repository URL을 입력하면 프로젝트 구조를 분석합니다."],
  ["프로젝트 맥락 분석", "요청 흐름, 데이터 플로우, 주요 모듈, 변경 영향도를 파악합니다."],
  ["이해도 질문 생성", "단순 개념 질문이 아니라 실제 프로젝트 코드 기반 질문을 생성합니다."],
  ["답변 제출", "사용자가 직접 자신의 프로젝트 구조를 설명합니다."],
  ["코드 근거 기반 피드백", "답변이 실제 코드와 맞는지 확인하고 다시 봐야 할 파일을 알려줍니다."]
];

const FEATURES = [
  ["Request Flow Questions", "사용자 요청이 어디서 시작해서 어떤 계층을 거쳐 처리되는지 질문합니다."],
  ["Data Flow Questions", "데이터가 생성, 검증, 저장, 반환되는 흐름을 이해하고 있는지 확인합니다."],
  ["Change Impact Questions", "특정 기능을 수정할 때 어떤 파일과 모듈에 영향이 생기는지 질문합니다."],
  ["Code-grounded Feedback", "AI의 추측이 아니라 실제 코드 근거를 기반으로 답변을 평가합니다."],
  ["Files to Review", "부족한 답변을 개선하기 위해 다시 봐야 할 파일을 추천합니다."],
  ["Interview Mode", "개발자 면접에서 받을 수 있는 프로젝트 질문과 꼬리 질문으로 확장합니다."]
];

const INTERACTIVE_DEMOS = [
  {
    label: "요청 흐름",
    title: "로그인 요청은 어떤 파일들을 거쳐 처리되나요?",
    files: [
      ["AuthController.java", "로그인 HTTP 요청을 받고 service 계층으로 넘기는 진입점입니다."],
      ["AuthService.java", "계정 검증과 인증 결과 처리를 담당하는 비즈니스 계층입니다."],
      ["JwtTokenProvider.java", "인증 성공 이후 access token 생성 책임이 분리된 파일입니다."],
      ["SecurityConfig.java", "인증 필터와 보호 경로가 실제 요청 흐름에 연결되는 설정입니다."]
    ],
    feedback: "Controller 진입점은 잘 짚었지만, JWT 생성 책임과 인증 필터 등록 흐름을 함께 설명해야 합니다.",
    weakAnswer: "AuthController에서 로그인 요청을 받고 AuthService에서 토큰을 만들어 응답합니다.",
    betterAnswer:
      "로그인 요청은 AuthController에서 시작해 AuthService로 전달되고, 계정 검증 후 JwtTokenProvider가 토큰 생성을 담당합니다. SecurityConfig에서는 인증 필터와 보호 경로가 등록되어 이후 요청 인증 흐름에 영향을 줍니다.",
    score: 72
  },
  {
    label: "데이터 흐름",
    title: "사용자 프로필 데이터는 어디서 검증되고 저장되나요?",
    files: [
      ["ProfileRequest.ts", "화면에서 입력된 프로필 데이터의 client-side 형태를 확인할 수 있습니다."],
      ["UserService.java", "프로필 수정 규칙과 서버 검증 흐름이 모이는 계층입니다."],
      ["UserRepository.java", "검증된 사용자 데이터가 저장소로 이동하는 경계입니다."],
      ["UserEntity.java", "실제로 저장되는 필드와 제약 조건을 확인할 수 있습니다."]
    ],
    feedback: "입력값이 화면에서 시작되는 흐름은 이해했지만, 서버 검증과 persistence 계층 설명이 부족합니다.",
    weakAnswer: "프로필 화면에서 입력한 데이터가 API를 타고 DB에 저장됩니다.",
    betterAnswer:
      "프로필 입력값은 프론트엔드 request 형태로 만들어지고, 서버의 UserService에서 수정 가능 여부와 값 검증을 거칩니다. 이후 UserRepository를 통해 UserEntity에 매핑되어 저장되므로 entity 제약 조건까지 함께 확인해야 합니다.",
    score: 64
  },
  {
    label: "변경 영향도",
    title: "회원 탈퇴 정책을 바꾸면 어떤 모듈을 함께 확인해야 하나요?",
    files: [
      ["useDeleteAccount.ts", "탈퇴 요청을 발생시키는 화면/훅 흐름을 확인하는 파일입니다."],
      ["MemberService.java", "회원 상태 변경, 삭제 정책, 연관 데이터 처리 책임이 있는 계층입니다."],
      ["AuthContext.tsx", "탈퇴 후 클라이언트 인증 상태와 세션 정리 영향을 확인해야 합니다."],
      ["SecurityConfig.java", "탈퇴 후 접근 가능한 경로와 인증 정책 영향 여부를 확인합니다."]
    ],
    feedback: "서비스 로직 변경만 보면 부족합니다. 세션 정리, UI 상태, 인증 흐름까지 영향 범위를 연결해야 합니다.",
    weakAnswer: "MemberService의 탈퇴 로직만 바꾸면 됩니다.",
    betterAnswer:
      "회원 탈퇴 정책 변경은 MemberService의 도메인 로직뿐 아니라 useDeleteAccount의 요청 처리, AuthContext의 로그인 상태 정리, SecurityConfig의 인증 흐름까지 함께 확인해야 합니다. 탈퇴 후 세션과 접근 권한이 어긋나면 UX나 보안 문제가 생길 수 있습니다.",
    score: 58
  }
];

const TARGET_USERS = [
  "AI로 프로젝트를 만들었지만 구조가 헷갈리는 사람",
  "Cursor, Copilot, Claude Code 등 AI 코딩 도구를 자주 쓰는 사람",
  "바이브 코딩으로 앱은 만들었지만 내부 코드가 낯선 사람",
  "포트폴리오 프로젝트를 면접에서 설명해야 하는 개발자 취준생",
  "프로젝트를 유지보수 가능한 상태로 이해하고 싶은 주니어 개발자",
  "새 코드베이스를 빠르게 파악해야 하는 사람"
];

export default function Home() {
  const router = useRouter();
  const [activeDemoIndex, setActiveDemoIndex] = useState(0);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [answerMode, setAnswerMode] = useState<"weak" | "better">("weak");
  const activeDemo = INTERACTIVE_DEMOS[activeDemoIndex];
  const activeFile = activeDemo.files[activeFileIndex] ?? activeDemo.files[0];

  function goStart(source: string) {
    track("landing_cta_opened", { source });
    router.push("/start");
  }

  return (
    <main>
      <SiteNav onStartClick={() => goStart("nav")} />
      <section className="hero landing-hero" id="start">
        <div className="hero__inner">
          <div>
            <p className="eyebrow">AI 코드 이해도 테스트</p>
            <h1>
              AI가 만든 코드,
              <br />
              <span className="gradient-text">당신은 설명할 수 있나요?</span>
            </h1>
            <p className="hero__copy">
              KnowYourCode는 GitHub 저장소를 분석하고, 요청 흐름, 데이터 플로우, 변경 영향도를 질문으로 검증해
              당신이 프로젝트를 진짜 이해하고 있는지 확인해주는 AI 코드 이해도 테스트입니다.
            </p>
            <div className="hero-actions">
              <button className="primary-button" type="button" onClick={() => goStart("hero")}>
                내 코드 이해도 테스트하기
              </button>
              <a className="secondary-link-button" href="#interactive-preview">
                예시 먼저 보기
              </a>
            </div>
            <div className="hero__meta">
              <span>· Public repository 지원</span>
              <span>· Commit Mode 지원</span>
              <span>· 질문 5개 기반 테스트</span>
              <span>· 코드 근거 피드백</span>
            </div>
          </div>
          <HeroPreview />
        </div>
      </section>

      <LandingSection label="문제 제기" title="요즘 AI는 코드를 빠르게 만들어줍니다.">
        <div className="landing-copy-grid">
          <div className="landing-prose">
            <p>에러가 나도 AI가 고쳐주고, 기능이 필요하면 AI가 구현해주고, 테스트도 AI가 작성해줍니다.</p>
            <p>
              하지만 AI는 코드를 만들어줄 수 있어도, 그 코드의 맥락을 이해하는 책임까지 대신 가져가주지는 않습니다.
            </p>
          </div>
          <ul className="landing-check-list">
            {PAIN_POINTS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </LandingSection>

      <LandingSection label="핵심 질문" title="당신은 자신의 프로젝트에 대해 이런 질문에 답할 수 있나요?">
        <div className="question-grid">
          {CORE_QUESTIONS.map((question) => (
            <article key={question}>{question}</article>
          ))}
        </div>
        <p className="landing-emphasis">답하기 어렵다면, 코드는 있지만 아직 완전히 내 코드는 아닐 수 있습니다.</p>
      </LandingSection>

      <LandingSection label="Solution" title="KnowYourCode는 코드를 대신 설명해주는 서비스가 아닙니다.">
        <div className="solution-panel">
          <p>
            GitHub 저장소를 입력하면 KnowYourCode가 프로젝트를 분석하고, 실제 코드 맥락을 기반으로 질문을 생성합니다.
            당신은 직접 답변하고, AI는 코드 근거를 기준으로 피드백합니다.
          </p>
          <strong>당신이 코드를 이해했는지 검증하는 서비스입니다.</strong>
        </div>
      </LandingSection>

      <LandingSection label="How It Works" title="저장소 입력부터 최종 피드백까지 한 흐름으로 진행됩니다.">
        <div className="steps-grid">
          {HOW_IT_WORKS.map(([title, description], index) => (
            <article key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
        <div className="inline-cta">
          <div>
            <p className="section-label">바로 시작하기</p>
            <h3>내 GitHub 저장소로 이해도 테스트를 시작하세요.</h3>
          </div>
          <button className="primary-button" type="button" onClick={() => goStart("inline")}>
            GitHub URL 입력하기 →
          </button>
        </div>
      </LandingSection>

      <LandingSection label="Example Question" title="실제 코드 흐름을 기준으로 질문하고 피드백합니다.">
        <ExampleQuestion />
      </LandingSection>

      <LandingSection label="Interactive Preview" title="질문 유형을 바꾸면 평가 관점도 달라집니다." id="interactive-preview">
        <div className="interactive-demo">
          <div className="interactive-demo__tabs" role="tablist" aria-label="예시 질문 유형">
            {INTERACTIVE_DEMOS.map((demo, index) => (
              <button
                key={demo.label}
                type="button"
                className={index === activeDemoIndex ? "is-active" : ""}
                onClick={() => {
                  setActiveDemoIndex(index);
                  setActiveFileIndex(0);
                  setAnswerMode("weak");
                }}
                role="tab"
                aria-selected={index === activeDemoIndex}
              >
                {demo.label}
              </button>
            ))}
          </div>
          <div className="interactive-demo__panel">
            <div className="interactive-demo__question">
              <p className="section-label">예시 질문</p>
              <h3>{activeDemo.title}</h3>
              <div className="interactive-demo__flow" aria-label="관련 파일 흐름">
                {activeDemo.files.map(([file], index) => (
                  <button
                    key={file}
                    type="button"
                    className={index === activeFileIndex ? "is-active" : ""}
                    onClick={() => setActiveFileIndex(index)}
                  >
                    <span>{index + 1}</span>
                    {file}
                  </button>
                ))}
              </div>
              <div className="interactive-demo__file-detail">
                <strong>{activeFile[0]}</strong>
                <p>{activeFile[1]}</p>
              </div>
            </div>
            <div className="interactive-demo__feedback">
              <div className="interactive-demo__score">
                <strong>{activeDemo.score}</strong>
                <span>이해도 점수</span>
              </div>
              <p>{activeDemo.feedback}</p>
              <div className="answer-toggle" role="group" aria-label="답변 비교">
                <button type="button" className={answerMode === "weak" ? "is-active" : ""} onClick={() => setAnswerMode("weak")}>
                  부족한 답변
                </button>
                <button type="button" className={answerMode === "better" ? "is-active" : ""} onClick={() => setAnswerMode("better")}>
                  개선 답변
                </button>
              </div>
              <div className="answer-sample">
                <p>{answerMode === "weak" ? activeDemo.weakAnswer : activeDemo.betterAnswer}</p>
              </div>
            </div>
          </div>
        </div>
      </LandingSection>

      <LandingSection label="핵심 기능" title="프로젝트를 진짜 이해했는지 확인하는 질문과 피드백">
        <div className="feature-grid">
          {FEATURES.map(([title, description]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </LandingSection>

      <LandingSection label="Before / After" title="AI가 만든 코드를 진짜 내 코드로 바꾸는 과정">
        <div className="before-after-grid">
          <article>
            <p className="section-label">Before KnowYourCode</p>
            <ul>
              <li>어떤 흐름으로 동작하는지 정확히 설명하기 어렵습니다.</li>
              <li>AI의 답변이 맞는지 판단하기 어렵습니다.</li>
              <li>기능을 수정할 때 영향 범위를 몰라 불안합니다.</li>
            </ul>
          </article>
          <article>
            <p className="section-label">After KnowYourCode</p>
            <ul>
              <li>프로젝트의 요청 흐름과 데이터 흐름을 말로 설명할 수 있습니다.</li>
              <li>AI가 작성한 코드가 기존 구조와 맞는지 판단할 수 있습니다.</li>
              <li>면접이나 코드리뷰에서 프로젝트를 근거 있게 설명할 수 있습니다.</li>
            </ul>
          </article>
        </div>
      </LandingSection>

      <LandingSection label="이런 사람에게 필요합니다" title="AI 코딩을 쓰는 개발자라면 코드 이해도 검증이 필요합니다.">
        <div className="target-grid">
          {TARGET_USERS.map((target) => (
            <article key={target}>{target}</article>
          ))}
        </div>
      </LandingSection>

      <section className="landing-final-cta">
        <div>
          <p className="eyebrow">Why KnowYourCode</p>
          <h2>AI coding tools help you write code faster.</h2>
          <p>KnowYourCode helps you understand what you built.</p>
          <strong>AI가 만든 코드, 이제 진짜 내 코드로 만드세요.</strong>
        </div>
        <button className="primary-button" type="button" onClick={() => goStart("final")}>
          GitHub 저장소로 이해도 테스트 시작하기
        </button>
      </section>
      <FeedbackCta />
      <FloatingStartCta onClick={() => goStart("floating")} />
    </main>
  );
}

function FeedbackCta() {
  return (
    <section className="feedback-cta">
      <div>
        <p className="section-label">MVP Feedback</p>
        <h2>KnowYourCode를 더 정확한 코드 이해도 테스트로 만들고 있습니다.</h2>
        <p>서비스를 사용해본 뒤 분석 결과, 질문, 피드백 품질에 대한 의견을 남겨주세요.</p>
      </div>
      <TallyFeedbackButton className="feedback-button" source="landing">
        피드백 남기기
      </TallyFeedbackButton>
    </section>
  );
}

function FloatingStartCta({ onClick }: { onClick: () => void }) {
  return (
    <aside className="floating-cta">
      <button className="floating-cta__trigger" type="button" onClick={onClick}>
        테스트 시작
      </button>
    </aside>
  );
}

function LandingSection({
  label,
  title,
  children,
  id
}: {
  label: string;
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="landing-section" id={id}>
      <div className="landing-section__header">
        <p className="section-label">{label}</p>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ExampleQuestion() {
  return (
    <div className="example-panel">
      <article>
        <p className="section-label">질문</p>
        <h3>로그인 요청이 들어왔을 때 Controller부터 Token 발급까지 어떤 파일을 거쳐 처리되는지 설명해보세요.</h3>
      </article>
      <article>
        <p className="section-label">관련 파일</p>
        <ul>
          <li>AuthController.java</li>
          <li>AuthService.java</li>
          <li>JwtTokenProvider.java</li>
          <li>SecurityConfig.java</li>
        </ul>
      </article>
      <article className="wide">
        <p className="section-label">피드백 예시</p>
        <p>
          Controller에서 요청을 받는 흐름은 잘 설명했습니다. 다만 실제 코드에서는 JWT 생성 책임이 AuthService가 아니라
          JwtTokenProvider에 분리되어 있습니다. 또한 SecurityConfig에서 인증 필터가 등록되는 흐름이 빠져 있습니다.
        </p>
      </article>
    </div>
  );
}

function SiteNav({ onStartClick }: { onStartClick: () => void }) {
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
          <button type="button" onClick={onStartClick}>테스트 시작</button>
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
        <span>quiz / code-understanding</span>
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
              <span>Request Flow</span>
              <span>Medium</span>
            </div>
            <div>
              <span>Change Impact</span>
              <span>Risk</span>
            </div>
            <div>
              <span>Evidence</span>
              <span>Files</span>
            </div>
          </div>
        </div>
        <div className="preview-panel">
          <small>Question 03</small>
          <div className="tag-list">
            <span className="tag danger">Auth Flow</span>
            <span className="tag warning">Data Flow</span>
            <span className="tag success">Code Grounded</span>
          </div>
          <p className="preview-question">로그인 요청이 어떤 API route와 service 파일을 거쳐 처리되는지 설명해보세요.</p>
        </div>
      </div>
    </aside>
  );
}
