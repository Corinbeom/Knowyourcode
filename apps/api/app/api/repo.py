from fastapi import APIRouter, Depends, HTTPException

from app.schemas.repo import AnalyzeRepoRequest, AnalyzeRepoResponse
from app.security import rate_limiter
from app.services.github_repo import fetch_repo_files, parse_github_repo_url
from app.services.llm import generate_repo_analysis
from app.services.repo_analysis import (
    build_fallback_repo_analysis,
    build_repo_static_context,
    normalize_focus,
    normalize_question_level,
    normalize_question_targets,
    normalize_question_types,
)

router = APIRouter()
repo_rate_limit = rate_limiter("analyze_repo", "API_ANALYZE_REPO_LIMIT_PER_HOUR", 5)


@router.post("/analyze", response_model=AnalyzeRepoResponse, dependencies=[Depends(repo_rate_limit)])
def analyze_repo(payload: AnalyzeRepoRequest) -> dict:
    try:
        repo = parse_github_repo_url(payload.url)
        files = fetch_repo_files(repo)
        if not files:
            raise HTTPException(status_code=422, detail="분석 가능한 텍스트 파일을 찾지 못했습니다.")

        focus = normalize_focus(payload.focus)
        question_level = normalize_question_level(payload.questionLevel)
        question_types = normalize_question_types(payload.questionTypes)
        question_targets = normalize_question_targets(payload.questionTargets)

        context = build_repo_static_context(repo, files, focus, question_level, question_types, question_targets)
        fallback = build_fallback_repo_analysis(context)
        analysis = generate_repo_analysis(context, fallback)
        return {"analysis": analysis}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
