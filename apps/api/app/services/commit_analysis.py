from datetime import datetime, timezone
import re

from app.services.redaction import redact_secrets


MAX_CONTEXT_FILES = 12
MAX_PATCH_EXCERPT = 2400
MAX_EVIDENCE_SNIPPETS = 18
MAX_HUNK_EXCERPT = 1800
OMITTED_AFTER_DIFF_MARKER = "... 이후 변경 내용 생략 ..."


def build_commit_static_context(commit_changes: dict) -> dict:
    ranked_files = sorted(commit_changes["files"], key=score_commit_file, reverse=True)
    context_files = [to_commit_file_summary(file) for file in ranked_files[:MAX_CONTEXT_FILES]]
    evidence_snippets = build_commit_evidence_snippets(ranked_files)

    return {
        "commit": commit_changes["commit"],
        "files": commit_changes["files"],
        "totalAdditions": commit_changes["totalAdditions"],
        "totalDeletions": commit_changes["totalDeletions"],
        "contextFiles": context_files,
        "evidenceSnippets": evidence_snippets,
    }


def build_fallback_commit_analysis(context: dict) -> dict:
    key_files = context["contextFiles"][:6]
    evidence_snippets = context.get("evidenceSnippets", [])
    first_path = key_files[0]["path"] if len(key_files) > 0 else "변경 파일"
    second_path = key_files[1]["path"] if len(key_files) > 1 else first_path
    third_path = key_files[2]["path"] if len(key_files) > 2 else second_path
    fourth_path = key_files[3]["path"] if len(key_files) > 3 else first_path
    fallback_evidence = [
        pick_evidence_for_path(evidence_snippets, first_path),
        pick_evidence_for_path(evidence_snippets, second_path),
        pick_evidence_for_path(evidence_snippets, third_path),
        pick_evidence_for_path(evidence_snippets, fourth_path),
    ]

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
        "evidenceSnippets": evidence_snippets,
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
                "evidenceSnippets": compact_evidence_list([fallback_evidence[0]]),
            },
            {
                "id": "q2",
                "type": "변경 영향도",
                "question": f"{second_path} 변경이 연결된 기능이나 모듈에 어떤 영향을 줄 수 있나요?",
                "relatedFiles": [second_path],
                "evidenceSnippets": compact_evidence_list([fallback_evidence[1]]),
            },
            {
                "id": "q3",
                "type": "테스트/리스크",
                "question": f"{third_path} 변경 후 어떤 테스트나 예외 케이스를 확인해야 하나요?",
                "relatedFiles": [third_path],
                "evidenceSnippets": compact_evidence_list([fallback_evidence[2]]),
            },
            {
                "id": "q4",
                "type": "리뷰형",
                "question": f"코드 리뷰에서 {fourth_path} 변경의 책임 분리, 예외 처리, 회귀 위험 중 무엇을 질문받을 수 있나요?",
                "relatedFiles": [fourth_path],
                "evidenceSnippets": compact_evidence_list([fallback_evidence[3]]),
            },
        ],
    }


def split_patch_hunks(file: dict) -> list[dict]:
    patch = redact_secrets(str(file.get("patch") or ""))
    if not patch:
        return []

    parts = re.split(r"(?=^@@ .+? @@)", patch, flags=re.M)
    hunks = []
    for index, part in enumerate(item.strip() for item in parts if item.strip()):
        lines = part.splitlines()
        header = lines[0] if lines and lines[0].startswith("@@") else f"파일 변경 {index + 1}"
        hunks.append(
            {
                "index": index,
                "header": header,
                "excerpt": truncate_diff_excerpt(part, MAX_HUNK_EXCERPT),
            }
        )
    return hunks


def truncate_diff_excerpt(content: str, limit: int) -> str:
    if len(content) <= limit:
        return content

    available = max(0, limit - len(OMITTED_AFTER_DIFF_MARKER) - 1)
    truncated = content[:available]
    last_newline = truncated.rfind("\n")
    if last_newline >= 0:
        truncated = truncated[:last_newline]
    return f"{truncated.rstrip()}\n{OMITTED_AFTER_DIFF_MARKER}"


def build_commit_evidence_snippets(files: list[dict]) -> list[dict]:
    snippets = []
    for file in files:
        hunks = split_patch_hunks(file)
        if hunks:
            for hunk in hunks:
                snippets.append(to_code_evidence(file, hunk))
        else:
            snippets.append(to_code_evidence(file, None))

    return sorted(snippets, key=lambda item: item["score"], reverse=True)[:MAX_EVIDENCE_SNIPPETS]


def to_code_evidence(file: dict, hunk: dict | None) -> dict:
    path = str(file.get("path") or "unknown")
    change_type = str(file.get("status") or "changed")
    hunk_index = hunk["index"] if hunk else 0
    header = hunk["header"] if hunk else "patch unavailable"
    excerpt = hunk["excerpt"] if hunk else fallback_evidence_excerpt(file)
    reason = infer_commit_file_reason(file)

    return {
        "id": f"{sanitize_evidence_id(path)}:{hunk_index}",
        "path": path,
        "title": f"{path} {header}",
        "reason": reason,
        "excerpt": excerpt,
        "kind": change_type,
        "changeType": change_type,
        "score": score_commit_file(file) + score_hunk_text(excerpt),
    }


def fallback_evidence_excerpt(file: dict) -> str:
    header_parts = [
        f"status: {file.get('status')}",
        f"additions: {file.get('additions')}",
        f"deletions: {file.get('deletions')}",
    ]
    if file.get("previousPath"):
        header_parts.append(f"previousPath: {file['previousPath']}")
    header_parts.append("(GitHub API에서 diff patch를 제공하지 않는 파일입니다.)")
    return "\n".join(header_parts)


def sanitize_evidence_id(path: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", path).strip("-") or "unknown"


def score_hunk_text(text: str) -> int:
    score = min(len(text), 1200) // 80
    if re.search(r"function|class|def |return|throw|catch|async|await|export|import", text):
        score += 20
    if re.search(r"test|spec|mock|assert|expect", text, re.I):
        score -= 10
    return score


def pick_evidence_for_path(snippets: list[dict], path: str) -> dict | None:
    return next((snippet for snippet in snippets if snippet.get("path") == path), None) or (snippets[0] if snippets else None)


def compact_evidence_list(snippets: list[dict | None]) -> list[dict]:
    result = []
    seen = set()
    for snippet in snippets:
        if not snippet or snippet.get("id") in seen:
            continue
        seen.add(snippet.get("id"))
        result.append({key: snippet[key] for key in ["id", "path", "title", "reason", "excerpt", "kind"] if key in snippet})
    return result


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
    patch = redact_secrets(file.get("patch") or "(GitHub API에서 diff patch를 제공하지 않는 파일입니다.)")

    return {
        "path": file.get("path") or "unknown",
        "reason": infer_commit_file_reason(file),
        "excerpt": "\n".join(header_parts) + "\n" + truncate_diff_excerpt(patch, MAX_PATCH_EXCERPT),
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
