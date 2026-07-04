from typing import Literal

from pydantic import BaseModel


AnalysisFocus = Literal["balanced", "frontend", "backend"]
QuestionLevel = Literal["basic", "standard", "deep"]
QuestionType = Literal["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"]


class AnalyzeRepoRequest(BaseModel):
    url: str
    focus: AnalysisFocus | None = None
    questionLevel: QuestionLevel | None = None
    questionTypes: list[QuestionType] | None = None
    questionTargets: list[str] | str | None = None


class AiUsage(BaseModel):
    provider: Literal["gemini", "groq", "fallback"]
    used: bool
    reason: str | None = None


class RepoInfo(BaseModel):
    owner: str
    repo: str
    branch: str | None = None
    url: str


class FileSummary(BaseModel):
    path: str
    reason: str
    excerpt: str = ""


class ProjectReport(BaseModel):
    oneLineSummary: str
    techStack: list[str]
    folderStructure: list[str]
    coreFeatures: list[str]
    requestFlow: str
    dataFlow: str
    keyFiles: list[FileSummary]
    difficulty: Literal["쉬움", "보통", "어려움"]
    riskyQuestions: list[str]


class UnderstandingQuestion(BaseModel):
    id: str
    type: QuestionType
    question: str
    relatedFiles: list[str]


class RepoAnalysisResult(BaseModel):
    repo: RepoInfo
    analyzedAt: str
    fileCount: int
    focus: AnalysisFocus
    questionLevel: QuestionLevel
    questionTypes: list[QuestionType]
    questionTargets: list[str]
    ai: AiUsage
    report: ProjectReport
    questions: list[UnderstandingQuestion]
    contextFiles: list[FileSummary]


class AnalyzeRepoResponse(BaseModel):
    analysis: RepoAnalysisResult
