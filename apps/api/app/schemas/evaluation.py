from typing import Literal

from pydantic import BaseModel


class QuizAnswer(BaseModel):
    questionId: str
    answer: str


class EvaluateAnswerRequest(BaseModel):
    analysis: dict
    questionId: str
    answer: str


class EvaluateQuizRequest(BaseModel):
    analysis: dict
    answers: list[QuizAnswer]


class EvaluationResult(BaseModel):
    score: int
    scoreReason: str
    understood: list[str]
    missing: list[str]
    incorrect: list[str]
    relatedFiles: list[str]
    reviewCode: list[str]
    betterAnswer: str
    interviewAnswerDirection: str
    followUpQuestion: str
    evaluationStatus: Literal["graded", "invalid_question"] | None = None
    answerType: Literal["substantive", "insufficient", "question_challenge"] | None = None
    invalidReason: str | None = None
    evidenceReferences: list[dict[str, str]] | None = None


class QuestionEvaluation(EvaluationResult):
    questionId: str


class QuizEvaluationResult(BaseModel):
    averageScore: int
    summary: str
    strengths: list[str]
    weaknesses: list[str]
    reviewFiles: list[str]
    questionEvaluations: list[QuestionEvaluation]


class EvaluateAnswerResponse(BaseModel):
    evaluation: EvaluationResult
    limits: dict | None = None


class EvaluateQuizResponse(BaseModel):
    evaluation: QuizEvaluationResult
    limits: dict | None = None
