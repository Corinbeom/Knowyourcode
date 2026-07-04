"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import { loadAnalysisResult, loadQuizSession } from "@/lib/analysis-session";
import { TallyFeedbackButton } from "@/app/tally-feedback-button";
import type { AnalysisFocus, AnalysisResult, QuestionEvaluation, QuestionLevel, QuestionType, QuizAnswer, QuizEvaluationResult } from "@/lib/types";

const ALL_QUESTION_TYPES: QuestionType[] = ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"];

export default function ResultPage() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [evaluation, setEvaluation] = useState<QuizEvaluationResult | null>(null);

  useEffect(() => {
    const storedAnalysis = loadAnalysisResult();
    if (!storedAnalysis) {
      router.replace("/");
      return;
    }

    const storedQuiz = loadQuizSession();
    if (!storedQuiz?.evaluation) {
      router.replace("/quiz");
      return;
    }

    setAnalysis(storedAnalysis);
    setAnswers(storedQuiz.answers);
    setEvaluation(storedQuiz.evaluation);
    track("result_viewed", { averageScore: storedQuiz.evaluation.averageScore });
  }, [router]);

  const answerMap = useMemo(
    () => new Map(answers.map((answer) => [answer.questionId, answer.answer])),
    [answers]
  );

  if (!analysis || !evaluation) return null;

  return (
    <main>
      <SiteNav />
      <FloatingFeedbackButton />
      <section className="workspace result-workspace">
        <div className="result-actions">
          <button className="secondary-button" type="button" onClick={() => router.push("/")}>
            새 저장소 분석
          </button>
        </div>
        <ResultSummary analysis={analysis} evaluation={evaluation} />
        <ProjectReportView analysis={analysis} />
        <QuizResultView analysis={analysis} evaluation={evaluation} answerMap={answerMap} />
        <PricingCta />
        <FeedbackCta />
      </section>
    </main>
  );
}

function ResultSummary({ analysis, evaluation }: { analysis: AnalysisResult; evaluation: QuizEvaluationResult }) {
  return (
    <section className="result-summary">
      <div>
        <p className="section-label">최종 결과</p>
        <h1>{analysis.repo.owner}/{analysis.repo.repo}</h1>
        <p>{evaluation.summary}</p>
        <div className="report__badges">
          <div className="focus-chip">{formatFocusLabel(analysis.focus)}</div>
          <div className="level-chip">{formatQuestionLevelLabel(analysis.questionLevel)}</div>
          <div className="type-chip">{formatQuestionTypesLabel(analysis.questionTypes)}</div>
          {analysis.questionTargets.length ? <div className="target-chip">{analysis.questionTargets.join(", ")}</div> : null}
        </div>
      </div>
      <div className="result-score">
        <strong>{evaluation.averageScore}</strong>
        <span>평균 점수</span>
      </div>
    </section>
  );
}

function FloatingFeedbackButton() {
  return (
    <TallyFeedbackButton className="floating-feedback-button" source="result_floating">
      피드백
    </TallyFeedbackButton>
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

function QuizResultView({
  analysis,
  evaluation,
  answerMap
}: {
  analysis: AnalysisResult;
  evaluation: QuizEvaluationResult;
  answerMap: Map<string, string>;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedEvaluation = evaluation.questionEvaluations[selectedIndex] ?? evaluation.questionEvaluations[0];
  const selectedQuestion = analysis.questions.find((candidate) => candidate.id === selectedEvaluation?.questionId);
  const questionCount = evaluation.questionEvaluations.length;

  function moveQuestion(direction: -1 | 1) {
    setSelectedIndex((current) => {
      const next = current + direction;
      if (next < 0) return questionCount - 1;
      if (next >= questionCount) return 0;
      return next;
    });
  }

  if (!selectedEvaluation || !selectedQuestion) return null;

  return (
    <section className="quiz-result">
      <div className="report-section-heading">
        <p className="section-label">퀴즈 피드백</p>
        <h3>문항별 결과</h3>
        <p>문항을 하나씩 이동하며 내 답변과 코드 근거 기반 피드백을 확인하세요.</p>
      </div>
      <div className="result-insights">
        <InfoBlock title="잘한 부분" items={evaluation.strengths} />
        <InfoBlock title="보완할 부분" items={evaluation.weaknesses} />
        <InfoBlock title="다시 볼 파일" items={evaluation.reviewFiles} />
      </div>
      <div className="question-score-nav" aria-label="문항별 점수">
        {evaluation.questionEvaluations.map((item, index) => (
          <button
            key={item.questionId}
            type="button"
            className={index === selectedIndex ? "is-active" : ""}
            onClick={() => setSelectedIndex(index)}
          >
            <span>Q{index + 1}</span>
            <strong>{item.score}</strong>
          </button>
        ))}
      </div>
      <div className="question-result-shell">
        <button className="question-arrow" type="button" onClick={() => moveQuestion(-1)} aria-label="이전 문항">
          &lt;
        </button>
        <QuestionResultCard
          index={selectedIndex}
          question={selectedQuestion.question}
          type={selectedQuestion.type}
          answer={answerMap.get(selectedEvaluation.questionId) ?? ""}
          evaluation={selectedEvaluation}
          total={questionCount}
        />
        <button className="question-arrow" type="button" onClick={() => moveQuestion(1)} aria-label="다음 문항">
          &gt;
        </button>
      </div>
    </section>
  );
}

function QuestionResultCard({
  index,
  question,
  type,
  answer,
  evaluation,
  total
}: {
  index: number;
  question: string;
  type: QuestionType;
  answer: string;
  evaluation: QuestionEvaluation;
  total: number;
}) {
  return (
    <article className="question-result-card">
      <div className="question-result-card__header">
        <div>
          <span>{index + 1}. {type}</span>
          <h4>{question}</h4>
        </div>
        <div className="question-result-card__score">
          <strong>{evaluation.score}</strong>
          <small>{index + 1} / {total}</small>
        </div>
      </div>
      <div className="answer-review">
        <h5>내 답변</h5>
        <p>{answer}</p>
      </div>
      <div className="evaluation__content">
        <InfoBlock title="잘 이해한 부분" items={evaluation.understood} />
        <InfoBlock title="부족한 부분" items={evaluation.missing} />
        <InfoBlock title="잘못 설명한 부분" items={evaluation.incorrect.length ? evaluation.incorrect : ["명확한 오류는 감지되지 않았습니다."]} />
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
    </article>
  );
}

function PricingCta() {
  const [selectedPlan, setSelectedPlan] = useState("");
  const planMessage = selectedPlan
    ? `${selectedPlan}는 아직 준비 중입니다. MVP에서는 무료 이해도 테스트 결과를 먼저 제공하고, 유료 리포트/면접 패키지는 이후 오픈 예정입니다.`
    : "";

  return (
    <>
      <section className="pricing">
        <article>
          <h3>Deep Report</h3>
          <p>심화 흐름 분석, 질문 30개, 피드백 10회를 제공하는 유료 리포트.</p>
          <button type="button" onClick={() => {
            track("paid_plan_clicked", { plan: "Deep Report" });
            setSelectedPlan("Deep Report");
          }}>준비 중</button>
        </article>
        <article>
          <h3>Interview Pack</h3>
          <p>면접 질문, 꼬리 질문, 1분/3분 프로젝트 설명 스크립트까지 확장.</p>
          <button type="button" onClick={() => {
            track("paid_plan_clicked", { plan: "Interview Pack" });
            setSelectedPlan("Interview Pack");
          }}>준비 중</button>
        </article>
        <article>
          <h3>Pro</h3>
          <p>월 3개 repo 심화 분석, 답변 피드백, private repo 지원 예정.</p>
          <button type="button" onClick={() => {
            track("paid_plan_clicked", { plan: "Pro" });
            setSelectedPlan("Pro");
          }}>준비 중</button>
        </article>
      </section>
      {planMessage ? (
        <div className="pricing-notice" role="status">
          <strong>{selectedPlan}</strong>
          <p>{planMessage}</p>
        </div>
      ) : null}
    </>
  );
}

function FeedbackCta() {
  return (
    <section className="feedback-cta result-feedback-cta">
      <div>
        <p className="section-label">피드백 요청</p>
        <h2>분석 결과가 실제 프로젝트 이해에 도움이 되었나요?</h2>
        <p>1분만 시간을 내어 분석 정확도, 질문 품질, 피드백 유용성을 알려주세요.</p>
      </div>
      <TallyFeedbackButton className="feedback-button" source="result_bottom">
        피드백 남기기
      </TallyFeedbackButton>
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
