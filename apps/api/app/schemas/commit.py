from typing import Literal

from pydantic import BaseModel


class AnalyzeCommitRequest(BaseModel):
    url: str


class AiUsage(BaseModel):
    provider: Literal["gemini", "groq", "fallback"]
    used: bool
    reason: str | None = None


class CommitInfo(BaseModel):
    owner: str
    repo: str
    sha: str
    shortSha: str
    url: str
    message: str
    author: str
    committedAt: str


class FileSummary(BaseModel):
    path: str
    reason: str
    excerpt: str = ""


class CommitReport(BaseModel):
    oneLineSummary: str
    changeIntent: str
    impactScope: list[str]
    riskAreas: list[str]
    testSuggestions: list[str]
    changedFiles: list[FileSummary]


class CommitQuestion(BaseModel):
    id: str
    type: Literal["변경 의도", "변경 영향도", "테스트/리스크", "리뷰형"]
    question: str
    relatedFiles: list[str]


class CommitAnalysisResult(BaseModel):
    commit: CommitInfo
    analyzedAt: str
    fileCount: int
    totalAdditions: int
    totalDeletions: int
    ai: AiUsage
    report: CommitReport
    questions: list[CommitQuestion]
    contextFiles: list[FileSummary]


class AnalyzeCommitResponse(BaseModel):
    analysis: CommitAnalysisResult
    limits: dict | None = None
