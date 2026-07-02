import type { AnalysisFocus, AnalysisResult, QuestionLevel, QuestionType } from "./types";

export type AnalysisSetup = {
  url: string;
  focus: AnalysisFocus;
  questionLevel: QuestionLevel;
  questionTypes: QuestionType[];
  questionTargets: string;
};

const SETUP_KEY = "knowyourcode.analysisSetup";
const RESULT_KEY = "knowyourcode.analysisResult";

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
}

export function loadAnalysisResult(): AnalysisResult | null {
  if (typeof window === "undefined") return null;
  return parseJson<AnalysisResult>(window.sessionStorage.getItem(RESULT_KEY));
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
