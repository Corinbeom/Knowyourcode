from fastapi import APIRouter, Depends, HTTPException

from app.observability import set_api_sentry_context
from app.schemas.commit import AnalyzeCommitRequest, AnalyzeCommitResponse
from app.security import authenticated_quota_limiter, consume_authenticated_quota
from app.services.commit_analysis import build_commit_static_context, build_fallback_commit_analysis
from app.services.github_commit import fetch_commit_changes, parse_github_commit_url
from app.services.llm import generate_commit_analysis

router = APIRouter()
commit_quota_limit = authenticated_quota_limiter("analysis")


@router.post("/analyze-commit", response_model=AnalyzeCommitResponse)
def analyze_commit(payload: AnalyzeCommitRequest, quota: dict = Depends(commit_quota_limit)) -> dict:
    set_api_sentry_context(mode="commit", route="/analyze-commit", provider="api")
    try:
        commit_input = parse_github_commit_url(payload.url)
        commit_changes = fetch_commit_changes(commit_input)
        if not commit_changes["files"]:
            raise HTTPException(status_code=422, detail="분석 가능한 커밋 변경 파일을 찾지 못했습니다.")

        context = build_commit_static_context(commit_changes)
        fallback = build_fallback_commit_analysis(context)
        analysis = generate_commit_analysis(context, fallback)
        if not analysis.get("questions"):
            raise HTTPException(status_code=422, detail=analysis.get("ai", {}).get("reason") or "분석 가능한 실행 흐름이 부족합니다.")
        return {"analysis": analysis, "limits": consume_authenticated_quota(quota)}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
