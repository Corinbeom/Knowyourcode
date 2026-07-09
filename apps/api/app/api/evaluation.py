import json
import os

from fastapi import APIRouter, Depends, HTTPException

from app.observability import set_api_sentry_context
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
    set_api_sentry_context(mode="project", route="/evaluate", provider="api")
    answer = payload.answer.strip()
    validate_answer(answer)
    validate_analysis_payload(payload.analysis)
    try:
        evaluation = evaluate_answer(payload.analysis, payload.questionId, answer)
        return {"evaluation": evaluation, "limits": consume_authenticated_quota(quota)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/evaluate-quiz", response_model=EvaluateQuizResponse)
def evaluate_repo_quiz(payload: EvaluateQuizRequest, quota: dict = Depends(evaluate_quota_limit)) -> dict:
    set_api_sentry_context(mode="project", route="/evaluate-quiz", provider="api")
    validate_analysis_payload(payload.analysis)
    answers = normalize_answers(payload.analysis, payload.answers)
    evaluation = evaluate_quiz(payload.analysis, answers)
    return {"evaluation": evaluation, "limits": consume_authenticated_quota(quota)}


@router.post("/evaluate-commit-quiz", response_model=EvaluateQuizResponse)
def evaluate_commit_quiz(payload: EvaluateQuizRequest, quota: dict = Depends(evaluate_quota_limit)) -> dict:
    set_api_sentry_context(mode="commit", route="/evaluate-commit-quiz", provider="api")
    validate_analysis_payload(payload.analysis)
    answers = normalize_answers(payload.analysis, payload.answers)
    evaluation = evaluate_quiz(payload.analysis, answers, commit_mode=True)
    return {"evaluation": evaluation, "limits": consume_authenticated_quota(quota)}


def validate_answer(answer: str) -> None:
    if not answer:
        raise HTTPException(status_code=400, detail="답변을 입력해주세요.")
    max_answer_length = int(os.getenv("MAX_ANSWER_LENGTH", "4000"))
    if len(answer) > max_answer_length:
        raise HTTPException(status_code=413, detail=f"답변은 {max_answer_length:,}자 이하로 입력해주세요.")


def validate_analysis_payload(analysis: dict) -> None:
    if not isinstance(analysis, dict):
        raise HTTPException(status_code=400, detail="분석 결과 형식이 올바르지 않습니다.")

    max_payload_bytes = int(os.getenv("MAX_EVALUATION_PAYLOAD_BYTES", "250000"))
    payload_bytes = len(json.dumps(analysis, ensure_ascii=False).encode("utf-8"))
    if payload_bytes > max_payload_bytes:
        raise HTTPException(status_code=413, detail="평가 요청 크기가 너무 큽니다.")

    questions = analysis.get("questions") if isinstance(analysis.get("questions"), list) else []
    max_questions = int(os.getenv("MAX_EVALUATION_QUESTIONS", "10"))
    if not questions or len(questions) > max_questions:
        raise HTTPException(status_code=413, detail="평가할 질문 수가 허용 범위를 벗어났습니다.")

    context_files = analysis.get("contextFiles") if isinstance(analysis.get("contextFiles"), list) else []
    max_context_files = int(os.getenv("MAX_EVALUATION_CONTEXT_FILES", "20"))
    if len(context_files) > max_context_files:
        raise HTTPException(status_code=413, detail="평가 코드 근거 파일 수가 너무 많습니다.")

    evidence_count = len(analysis.get("evidenceSnippets") if isinstance(analysis.get("evidenceSnippets"), list) else [])
    for question in questions:
        if isinstance(question, dict) and isinstance(question.get("evidenceSnippets"), list):
            evidence_count += len(question["evidenceSnippets"])
    max_evidence_snippets = int(os.getenv("MAX_EVALUATION_EVIDENCE_SNIPPETS", "60"))
    if evidence_count > max_evidence_snippets:
        raise HTTPException(status_code=413, detail="평가 코드 근거 조각 수가 너무 많습니다.")

    max_excerpt_chars = int(os.getenv("MAX_EVALUATION_EXCERPT_CHARS", "5000"))
    for item in [*context_files, *(analysis.get("evidenceSnippets") if isinstance(analysis.get("evidenceSnippets"), list) else [])]:
        if isinstance(item, dict) and isinstance(item.get("excerpt"), str) and len(item["excerpt"]) > max_excerpt_chars:
            raise HTTPException(status_code=413, detail="평가 코드 근거 내용이 너무 깁니다.")
    for question in questions:
        if not isinstance(question, dict) or not isinstance(question.get("evidenceSnippets"), list):
            continue
        for snippet in question["evidenceSnippets"]:
            if isinstance(snippet, dict) and isinstance(snippet.get("excerpt"), str) and len(snippet["excerpt"]) > max_excerpt_chars:
                raise HTTPException(status_code=413, detail="평가 코드 근거 내용이 너무 깁니다.")


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
