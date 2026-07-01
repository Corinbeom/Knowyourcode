export type RepoInfo = {
  owner: string;
  repo: string;
  branch?: string;
  url: string;
};

export type SourceFile = {
  path: string;
  content: string;
  size: number;
};

export type AnalysisFocus = "balanced" | "frontend" | "backend";
export type QuestionLevel = "basic" | "standard" | "deep";

export type FileSummary = {
  path: string;
  reason: string;
  excerpt: string;
};

export type ProjectReport = {
  oneLineSummary: string;
  techStack: string[];
  folderStructure: string[];
  coreFeatures: string[];
  requestFlow: string;
  dataFlow: string;
  keyFiles: FileSummary[];
  difficulty: "쉬움" | "보통" | "어려움";
  riskyQuestions: string[];
};

export type UnderstandingQuestion = {
  id: string;
  type: "구조 이해" | "요청 흐름" | "데이터 흐름" | "변경 영향도" | "면접형";
  question: string;
  relatedFiles: string[];
};

export type AnalysisResult = {
  repo: RepoInfo;
  analyzedAt: string;
  fileCount: number;
  focus: AnalysisFocus;
  questionLevel: QuestionLevel;
  questionTargets: string[];
  ai: AiUsage;
  report: ProjectReport;
  questions: UnderstandingQuestion[];
  contextFiles: FileSummary[];
};

export type AiUsage = {
  provider: "gemini" | "groq" | "fallback";
  used: boolean;
  reason?: string;
};

export type EvaluationResult = {
  score: number;
  scoreReason: string;
  understood: string[];
  missing: string[];
  incorrect: string[];
  relatedFiles: string[];
  reviewCode: string[];
  betterAnswer: string;
  interviewAnswerDirection: string;
  followUpQuestion: string;
};
