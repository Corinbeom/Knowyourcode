from fastapi import APIRouter, Depends, HTTPException

from app.schemas.commit import AnalyzeCommitRequest, AnalyzeCommitResponse
from app.security import authenticated_quota_limiter
from app.services.commit_analysis import build_commit_static_context, build_fallback_commit_analysis
from app.services.github_commit import fetch_commit_changes, parse_github_commit_url
from app.services.llm import generate_commit_analysis

router = APIRouter()
commit_quota_limit = authenticated_quota_limiter("analysis")


@router.post("/analyze-commit", response_model=AnalyzeCommitResponse)
def analyze_commit(payload: AnalyzeCommitRequest, quota: dict = Depends(commit_quota_limit)) -> dict:
    try:
        commit_input = parse_github_commit_url(payload.url)
        commit_changes = fetch_commit_changes(commit_input)
        if not commit_changes["files"]:
            raise HTTPException(status_code=422, detail="분석 가능한 커밋 변경 파일을 찾지 못했습니다.")

        context = build_commit_static_context(commit_changes)
        fallback = build_fallback_commit_analysis(context)
        analysis = generate_commit_analysis(context, fallback)
        return {"analysis": analysis, "limits": quota.get("analysis")}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
