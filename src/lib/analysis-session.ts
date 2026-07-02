import type { AnalysisFocus, AnalysisResult, QuestionLevel, QuestionType, QuizAnswer, QuizEvaluationResult } from "./types";

export type AnalysisSetup = {
  url: string;
  focus: AnalysisFocus;
  questionLevel: QuestionLevel;
  questionTypes: QuestionType[];
  questionTargets: string;
};

export type QuizSession = {
  currentQuestionIndex: number;
  answers: QuizAnswer[];
  evaluation: QuizEvaluationResult | null;
};

const SETUP_KEY = "knowyourcode.analysisSetup";
const RESULT_KEY = "knowyourcode.analysisResult";
const QUIZ_KEY = "knowyourcode.quizSession";

export const DEFAULT_QUESTION_TYPES: QuestionType[] = ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"];

export function saveAnalysisSetup(setup: AnalysisSetup) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(SETUP_KEY, JSON.stringify(setup));
}

export function loadAnalysisSetup(): AnalysisSetup | null {
  if (typeof window === "undefined") return null;
  return parseJson<AnalysisSetup>(window.sessionStorage.getItem(SETUP_KEY));
}

export function saveAnalysisResult(analysis: AnalysisResult) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(RESULT_KEY, JSON.stringify(analysis));
  clearQuizSession();
}

export function loadAnalysisResult(): AnalysisResult | null {
  if (typeof window === "undefined") return null;
  return parseJson<AnalysisResult>(window.sessionStorage.getItem(RESULT_KEY));
}

export function saveQuizSession(session: QuizSession) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(QUIZ_KEY, JSON.stringify(session));
}

export function loadQuizSession(): QuizSession | null {
  if (typeof window === "undefined") return null;
  return parseJson<QuizSession>(window.sessionStorage.getItem(QUIZ_KEY));
}

export function clearQuizSession() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(QUIZ_KEY);
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
