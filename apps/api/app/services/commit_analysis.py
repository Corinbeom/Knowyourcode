from datetime import datetime, timezone
import re


MAX_CONTEXT_FILES = 12
MAX_PATCH_EXCERPT = 2400


def build_commit_static_context(commit_changes: dict) -> dict:
    ranked_files = sorted(commit_changes["files"], key=score_commit_file, reverse=True)
    context_files = [to_commit_file_summary(file) for file in ranked_files[:MAX_CONTEXT_FILES]]

    return {
        "commit": commit_changes["commit"],
        "files": commit_changes["files"],
        "totalAdditions": commit_changes["totalAdditions"],
        "totalDeletions": commit_changes["totalDeletions"],
        "contextFiles": context_files,
    }


def build_fallback_commit_analysis(context: dict) -> dict:
    key_files = context["contextFiles"][:6]
    first_path = key_files[0]["path"] if len(key_files) > 0 else "변경 파일"
    second_path = key_files[1]["path"] if len(key_files) > 1 else first_path
    third_path = key_files[2]["path"] if len(key_files) > 2 else second_path
    fourth_path = key_files[3]["path"] if len(key_files) > 3 else first_path

    return {
        "commit": context["commit"],
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
        "fileCount": len(context["files"]),
        "totalAdditions": context["totalAdditions"],
        "totalDeletions": context["totalDeletions"],
        "ai": {
            "provider": "fallback",
            "used": False,
            "reason": "LLM 응답을 사용하지 못해 커밋 기본 분석으로 대체했습니다.",
        },
        "contextFiles": key_files,
        "report": {
            "oneLineSummary": f"{context['commit']['shortSha']} 커밋의 변경 파일과 diff를 기반으로 한 코드 이해도 분석입니다.",
            "changeIntent": "커밋 메시지와 변경 파일을 기준으로 변경 의도를 직접 확인해야 합니다.",
            "impactScope": [f"{file['path']} 변경 영향 확인" for file in key_files],
            "riskAreas": ["변경된 파일의 호출 흐름과 테스트 보강 지점을 확인하세요."],
            "testSuggestions": ["변경된 기능의 정상 흐름과 예외 흐름을 함께 검증하세요."],
            "changedFiles": key_files,
        },
        "questions": [
            {
                "id": "q1",
                "type": "변경 의도",
                "question": f"{first_path} 변경은 어떤 문제를 해결하려는 의도인가요?",
                "relatedFiles": [first_path],
            },
            {
                "id": "q2",
                "type": "변경 영향도",
                "question": f"{second_path} 변경이 연결된 기능이나 모듈에 어떤 영향을 줄 수 있나요?",
                "relatedFiles": [second_path],
            },
            {
                "id": "q3",
                "type": "테스트/리스크",
                "question": f"{third_path} 변경 후 어떤 테스트나 예외 케이스를 확인해야 하나요?",
                "relatedFiles": [third_path],
            },
            {
                "id": "q4",
                "type": "리뷰형",
                "question": f"코드 리뷰에서 {fourth_path} 변경의 책임 분리, 예외 처리, 회귀 위험 중 무엇을 질문받을 수 있나요?",
                "relatedFiles": [fourth_path],
            },
        ],
    }


def score_commit_file(file: dict) -> int:
    score = int(file.get("changes") or 0)
    path = str(file.get("path") or "")
    if re.search(r"service|controller|route|api|domain|repository|entity|model|schema|auth|security", path, re.I):
        score += 40
    if re.search(r"\.(ts|tsx|js|jsx|java|kt|py|go|rs)$", path, re.I):
        score += 20
    if re.search(r"test|spec|__tests__", path, re.I):
        score -= 25
    if not file.get("patch"):
        score -= 20
    return score


def to_commit_file_summary(file: dict) -> dict:
    header_parts = [
        f"status: {file.get('status')}",
        f"additions: {file.get('additions')}",
        f"deletions: {file.get('deletions')}",
    ]
    if file.get("previousPath"):
        header_parts.append(f"previousPath: {file['previousPath']}")
    patch = file.get("patch") or "(GitHub API에서 diff patch를 제공하지 않는 파일입니다.)"

    return {
        "path": file.get("path") or "unknown",
        "reason": infer_commit_file_reason(file),
        "excerpt": "\n".join(header_parts) + "\n" + patch[:MAX_PATCH_EXCERPT],
    }


def infer_commit_file_reason(file: dict) -> str:
    path = str(file.get("path") or "")
    status = file.get("status")
    if status == "added":
        return "이번 커밋에서 새로 추가된 파일입니다."
    if status == "removed":
        return "이번 커밋에서 제거된 파일입니다."
    if status == "renamed":
        return "이번 커밋에서 이름이 변경된 파일입니다."
    if re.search(r"test|spec|__tests__", path, re.I):
        return "변경 검증 범위를 확인할 수 있는 테스트 파일입니다."
    if re.search(r"service|domain|usecase|handler", path, re.I):
        return "변경 의도와 비즈니스 로직 영향을 확인할 핵심 파일입니다."
    if re.search(r"controller|route|api", path, re.I):
        return "요청 진입점 또는 API 흐름 영향을 확인할 파일입니다."
    if re.search(r"component|page|screen|view|hook", path, re.I):
        return "사용자 화면 또는 클라이언트 상태 영향을 확인할 파일입니다."
    if re.search(r"config|security|auth", path, re.I):
        return "설정, 인증, 운영 영향 가능성을 확인할 파일입니다."
    return "이번 커밋에서 변경된 주요 파일입니다."
