import os

from fastapi import APIRouter, Depends, HTTPException

from app.schemas.evaluation import (
    EvaluateAnswerRequest,
    EvaluateAnswerResponse,
    EvaluateQuizRequest,
    EvaluateQuizResponse,
)
from app.security import authenticated_quota_limiter, consume_authenticated_quota
from app.services.evaluation import evaluate_answer, evaluate_quiz

router = APIRouter()
evaluate_quota_limit = authenticated_quota_limiter("evaluation")


@router.post("/evaluate", response_model=EvaluateAnswerResponse)
def evaluate_single_answer(payload: EvaluateAnswerRequest, quota: dict = Depends(evaluate_quota_limit)) -> dict:
    answer = payload.answer.strip()
    validate_answer(answer)
    try:
        evaluation = evaluate_answer(payload.analysis, payload.questionId, answer)
        return {"evaluation": evaluation, "limits": consume_authenticated_quota(quota)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/evaluate-quiz", response_model=EvaluateQuizResponse)
def evaluate_repo_quiz(payload: EvaluateQuizRequest, quota: dict = Depends(evaluate_quota_limit)) -> dict:
    answers = normalize_answers(payload.analysis, payload.answers)
    evaluation = evaluate_quiz(payload.analysis, answers)
    return {"evaluation": evaluation, "limits": consume_authenticated_quota(quota)}


@router.post("/evaluate-commit-quiz", response_model=EvaluateQuizResponse)
def evaluate_commit_quiz(payload: EvaluateQuizRequest, quota: dict = Depends(evaluate_quota_limit)) -> dict:
    answers = normalize_answers(payload.analysis, payload.answers)
    evaluation = evaluate_quiz(payload.analysis, answers, commit_mode=True)
    return {"evaluation": evaluation, "limits": consume_authenticated_quota(quota)}


def validate_answer(answer: str) -> None:
    if not answer:
        raise HTTPException(status_code=400, detail="답변을 입력해주세요.")
    max_answer_length = int(os.getenv("MAX_ANSWER_LENGTH", "4000"))
    if len(answer) > max_answer_length:
        raise HTTPException(status_code=413, detail=f"답변은 {max_answer_length:,}자 이하로 입력해주세요.")


def normalize_answers(analysis: dict, answers: list) -> list[dict]:
    question_ids = {question.get("id") for question in analysis.get("questions", [])}
    normalized = [
        {"questionId": item.questionId, "answer": item.answer.strip()}
        for item in answers
        if item.questionId in question_ids
    ]
    if len(normalized) != len(question_ids) or any(not item["answer"] for item in normalized):
        raise HTTPException(status_code=400, detail="모든 질문에 답변을 입력해주세요.")
    for item in normalized:
        validate_answer(item["answer"])
    return normalized
