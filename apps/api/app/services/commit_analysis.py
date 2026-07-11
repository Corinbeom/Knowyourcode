from datetime import datetime, timezone
import re

from app.services.redaction import redact_secrets


MAX_CONTEXT_FILES = 12
MAX_PATCH_EXCERPT = 2400
MAX_EVIDENCE_SNIPPETS = 18
MAX_HUNK_EXCERPT = 1800
MIN_COMMIT_QUESTIONS = 2
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
    question_evidence = strong_commit_evidence(evidence_snippets)
    if len(question_evidence) < MIN_COMMIT_QUESTIONS:
        return build_insufficient_commit_analysis(context)

    question_count = min(4, len(question_evidence))
    selected_evidence = question_evidence[:question_count]
    fallback_evidence = (selected_evidence + [selected_evidence[-1]] * 4)[:4]
    question_subjects = [commit_evidence_subject(item) for item in fallback_evidence]
    first_path, second_path, third_path, fourth_path = (question_subjects + [question_subjects[-1]] * 4)[:4]

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
        "questions": compact_questions(
            [
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
                "question": f"{third_path}의 정상 분기와 반환 동작을 검증하려면 어떤 입력과 결과를 확인해야 하나요?",
                "relatedFiles": [third_path],
                "evidenceSnippets": compact_evidence_list([fallback_evidence[2]]),
            },
            {
                "id": "q4",
                "type": "리뷰형",
                "question": f"코드 리뷰에서 {fourth_path} 변경의 구현 의도와 선택한 구현 방식을 어떻게 설명하겠습니까?",
                "relatedFiles": [fourth_path],
                "evidenceSnippets": compact_evidence_list([fallback_evidence[3]]),
            },
            ][:question_count]
        ),
    }


def build_insufficient_commit_analysis(context: dict) -> dict:
    return {
        "commit": context["commit"],
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
        "fileCount": len(context["files"]),
        "totalAdditions": context["totalAdditions"],
        "totalDeletions": context["totalDeletions"],
        "ai": {
            "provider": "fallback",
            "used": False,
            "reason": "분석 가능한 실행 흐름이 부족합니다.",
        },
        "contextFiles": key_context_files(context),
        "evidenceSnippets": context.get("evidenceSnippets", []),
        "report": {
            "oneLineSummary": f"{context['commit']['shortSha']} 커밋에서 질문으로 검증할 만한 substantive diff 근거가 충분하지 않습니다.",
            "changeIntent": "문서, 바이너리, patch unavailable, 상수-only 변경만으로는 변경 의도를 코드 흐름 기준으로 평가하지 않습니다.",
            "impactScope": ["실행 함수, handler, service, 검증/변환 흐름이 포함된 diff를 분석해주세요."],
            "riskAreas": ["분석 가능한 실행 흐름이 부족해 리뷰 위험 문항을 생성하지 않았습니다."],
            "testSuggestions": ["substantive code diff가 있는 커밋으로 다시 분석해주세요."],
            "changedFiles": key_context_files(context),
        },
        "questions": [],
    }


def key_context_files(context: dict) -> list[dict]:
    return context.get("contextFiles", [])[:6]


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
                evidence = to_code_evidence(file, hunk)
                if evidence.get("quality") != "weak":
                    snippets.append(evidence)

    return sorted(snippets, key=lambda item: item["score"], reverse=True)[:MAX_EVIDENCE_SNIPPETS]


def to_code_evidence(file: dict, hunk: dict | None) -> dict:
    path = str(file.get("path") or "unknown")
    change_type = str(file.get("status") or "changed")
    hunk_index = hunk["index"] if hunk else 0
    header = hunk["header"] if hunk else "patch unavailable"
    excerpt = hunk["excerpt"] if hunk else fallback_evidence_excerpt(file)
    scope = commit_hunk_scope(header, excerpt)
    excerpt = normalize_commit_hunk_excerpt(header, excerpt)
    reason = infer_commit_file_reason(file)

    return {
        "id": f"{sanitize_evidence_id(path)}:{hunk_index}",
        "path": path,
        "title": f"{path} · {scope or f'hunk {hunk_index + 1}'}",
        "reason": reason,
        "excerpt": excerpt,
        "kind": change_type,
        "changeType": change_type,
        "quality": classify_commit_evidence(path, header, excerpt),
        "score": score_commit_file(file) + score_hunk_text(excerpt),
    }


def commit_evidence_subject(snippet: dict) -> str:
    path = str(snippet.get("path") or "변경 파일")
    title = str(snippet.get("title") or "")
    scope = title.split("·", 1)[1].strip() if "·" in title else ""
    return f"{path}의 {scope}" if scope else path


def commit_hunk_scope(header: str, excerpt: str) -> str:
    header_context = header.split("@@", 2)[-1].strip() if header.startswith("@@") else ""
    _, scope = select_hunk_declaration(excerpt.splitlines(), header_context)
    return scope


def normalize_commit_hunk_excerpt(header: str, excerpt: str) -> str:
    lines = excerpt.splitlines()
    body = lines[1:] if lines and lines[0].startswith("@@") else lines
    header_context = header.split("@@", 2)[-1].strip() if header.startswith("@@") else ""
    index, scope = select_hunk_declaration(body, header_context)
    if index is not None:
        return "\n".join(body[index:]).strip()
    if scope:
        return "\n".join([header_context, *body]).strip()
    return excerpt


def select_hunk_declaration(lines: list[str], header_context: str) -> tuple[int | None, str]:
    callables = [(index, declaration_scope(line)) for index, line in enumerate(lines) if declaration_kind(line) == "callable"]
    changed_callables = [(index, scope) for index, scope in callables if lines[index].startswith(("+", "-"))]
    if changed_callables:
        return changed_callables[0]

    if callables:
        ranked = []
        for position, (index, scope) in enumerate(callables):
            end = callables[position + 1][0] if position + 1 < len(callables) else len(lines)
            changed_count = sum(
                1 for line in lines[index:end]
                if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))
            )
            ranked.append((changed_count, position, index, scope))
        _, _, index, scope = max(ranked)
        return index, scope

    changed_declarations = [
        (index, declaration_scope(line))
        for index, line in enumerate(lines)
        if line.startswith(("+", "-")) and declaration_scope(line)
    ]
    if changed_declarations:
        return changed_declarations[0]
    return None, declaration_scope(header_context)


def declaration_scope(line: str) -> str:
    code = re.sub(r"^[ +\-]", "", line).strip()
    match = re.search(
        r"(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|"
        r"\bdef\s+([A-Za-z_]\w*)|\bclass\s+([A-Za-z_]\w*)|"
        r"(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=",
        code,
    )
    return next((group for group in match.groups() if group), "") if match else ""


def declaration_kind(line: str) -> str:
    code = re.sub(r"^[ +\-]", "", line).strip()
    return "callable" if re.search(r"(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$]|\b(?:def|class)\s+[A-Za-z_]", code) else "value"


def classify_commit_evidence(path: str, header: str, excerpt: str) -> str:
    if not excerpt.strip() or header == "patch unavailable" or "patch를 제공하지 않는 파일" in excerpt:
        return "weak"
    if re.search(r"\.(md|mdx|txt|png|jpe?g|gif|svg|ico|lock)$", path, re.I):
        return "weak"
    changed_lines = "\n".join(
        line[1:].strip()
        for line in excerpt.splitlines()
        if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))
    )
    meaningful = strip_diff_noise(changed_lines)
    if not meaningful.strip():
        return "weak"
    if is_constant_only_change(meaningful):
        return "conditional"
    if has_substantive_diff_flow(meaningful):
        return "strong"
    return "conditional"


def strip_diff_noise(text: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "//", "/*", "*")):
            continue
        if re.match(r"^(import|from\s+\S+\s+import|export\s+\{)", stripped):
            continue
        lines.append(stripped)
    return "\n".join(lines)


def is_constant_only_change(text: str) -> bool:
    return bool(re.fullmatch(r"(?:(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*[^;\n]+;?\s*)+", text.strip(), re.S))


def has_substantive_diff_flow(text: str) -> bool:
    return bool(
        re.search(r"\b(function|def|class|async|await|return|if|elif|else|for|while|try|except|catch|throw|raise|with|yield)\b", text)
        and re.search(r"\w+\s*\(|return\s+|=>|request\.|response\.|fetch|query|save|create|update|delete|find|parse|validate", text, re.I)
    )


def strong_commit_evidence(snippets: list[dict]) -> list[dict]:
    return [snippet for snippet in snippets if snippet.get("quality") == "strong"]


def compact_questions(questions: list[dict]) -> list[dict]:
    return [question for question in questions if question.get("evidenceSnippets")]


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
        result.append({key: snippet[key] for key in ["id", "path", "title", "reason", "excerpt", "kind", "quality"] if key in snippet})
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
