from datetime import datetime, timezone
import json
import re

from app.services.redaction import redact_secrets

QUESTION_TYPES = ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"]
MAX_CONTEXT_FILES = 15
MAX_EXCERPT_LENGTH = 1600
MAX_EVIDENCE_SNIPPETS = 24
MAX_REPO_SNIPPET_LENGTH = 1200
OMITTED_BEFORE_MARKER = "... 이전 코드 생략 ..."
OMITTED_AFTER_MARKER = "... 이후 코드 생략 ..."


def normalize_focus(value: str | None) -> str:
    return value if value in {"frontend", "backend"} else "balanced"


def normalize_question_level(value: str | None) -> str:
    return value if value in {"basic", "standard", "deep"} else "standard"


def normalize_question_types(value: list[str] | None) -> list[str]:
    if not value:
        return QUESTION_TYPES
    selected = []
    for item in value:
        if item in QUESTION_TYPES and item not in selected:
            selected.append(item)
    return selected or QUESTION_TYPES


def normalize_question_targets(value: list[str] | str | None) -> list[str]:
    raw = value if isinstance(value, list) else re.split(r"[,;\n]", value or "")
    targets = []
    for item in raw:
        target = str(item).strip()[:32]
        if target and target not in targets:
            targets.append(target)
    return targets[:5]


def build_repo_static_context(
    repo: dict,
    files: list[dict],
    focus: str,
    question_level: str,
    question_types: list[str],
    question_targets: list[str],
) -> dict:
    selected_files = select_context_files(files, focus, question_targets)
    context_files = [to_file_summary(file) for file in selected_files]
    evidence_snippets = build_repo_evidence_snippets(selected_files, focus, question_targets)
    tree = summarize_tree(files)
    package_file = next((file for file in files if file["path"] == "package.json"), None)
    package_info = parse_package(package_file["content"]) if package_file else None

    return {
        "repo": repo,
        "focus": focus,
        "questionLevel": question_level,
        "questionTypes": question_types,
        "questionTargets": question_targets,
        "fileCount": len(files),
        "contextFiles": context_files,
        "evidenceSnippets": evidence_snippets,
        "tree": tree,
        "packageInfo": package_info,
    }


def build_fallback_repo_analysis(context: dict) -> dict:
    key_files = context["contextFiles"][:6]
    evidence_snippets = context.get("evidenceSnippets", [])
    request_evidence = pick_evidence_by_capability(evidence_snippets, supports_request_or_service_evidence, ["entry", "service"], 3)
    data_evidence = pick_evidence_by_capability(evidence_snippets, supports_data_flow_evidence, ["data", "service", "entry"], 3)
    request_files = [{"path": path} for path in evidence_paths(request_evidence)] or pick_context_files(context["contextFiles"], ["entry", "service"], 2)
    structure_file = pick_structure_context_file(context["contextFiles"], request_files)
    data_files = [{"path": path} for path in evidence_paths(data_evidence)] or pick_context_files(context["contextFiles"], ["data", "service"], 2)
    impact_files = pick_context_files(context["contextFiles"], ["service", "ui", "entry", "config"], 2)
    interview_files = pick_context_files(context["contextFiles"], ["entry", "service", "data", "config"], 2)
    first_path = structure_file["path"] if structure_file else "핵심 파일"
    second_path = request_files[0]["path"] if request_files else first_path
    data_path = data_files[0]["path"] if data_files else first_path
    question_types = context["questionTypes"]
    structure_evidence = compact_evidence_list([pick_evidence_for_path(evidence_snippets, first_path)])
    structure_subject = fallback_question_subject(structure_evidence[0]) if structure_evidence else f"{first_path}의 코드 조각"

    return {
        "repo": context["repo"],
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
        "fileCount": context["fileCount"],
        "focus": context["focus"],
        "questionLevel": context["questionLevel"],
        "questionTypes": question_types,
        "questionTargets": context["questionTargets"],
        "ai": {"provider": "fallback", "used": False, "reason": "LLM 응답을 사용하지 못해 기본 분석으로 대체했습니다."},
        "contextFiles": context["contextFiles"],
        "evidenceSnippets": evidence_snippets,
        "report": {
            "oneLineSummary": f"{context['repo']['repo']} 저장소의 구조와 핵심 파일을 기반으로 한 초기 코드 이해도 분석입니다.",
            "techStack": infer_stack(context["packageInfo"], context["contextFiles"]),
            "folderStructure": context["tree"][:12],
            "coreFeatures": ["README와 주요 소스 파일을 기준으로 핵심 기능을 확인해야 합니다."],
            "requestFlow": "라우트/API/서버 진입점 파일을 중심으로 요청 흐름을 추적하세요.",
            "dataFlow": "데이터 접근 계층, API 호출, 상태 관리 파일을 중심으로 데이터 흐름을 확인하세요.",
            "keyFiles": key_files,
            "difficulty": "어려움" if len(context["contextFiles"]) > 18 else "보통" if len(context["contextFiles"]) > 8 else "쉬움",
            "riskyQuestions": [
                "이 프로젝트의 실행 진입점은 어디인가요?",
                "핵심 기능 하나를 수정하려면 어떤 파일들을 함께 봐야 하나요?",
                "README에 적힌 기술 스택이 실제 코드에서 어디에 사용되나요?",
            ],
        },
        "questions": [
            {
                "id": "q1",
                "type": question_types[0],
                "question": f"{structure_subject}는 선택된 코드 흐름에서 어떤 역할을 담당하나요?",
                "relatedFiles": [first_path],
                "evidenceSnippets": structure_evidence,
            },
            {
                "id": "q2",
                "type": question_types[1 % len(question_types)],
                "question": f"{second_path}를 포함한 요청 처리 흐름이 어떤 파일들을 거쳐 이어지는지 설명해주세요.",
                "relatedFiles": [file["path"] for file in request_files] or [second_path],
                "evidenceSnippets": compact_evidence_list(request_evidence or [pick_evidence_for_path(evidence_snippets, file["path"]) for file in request_files] or [pick_evidence_for_path(evidence_snippets, second_path)]),
            },
            {
                "id": "q3",
                "type": question_types[2 % len(question_types)],
                "question": f"{data_path}에서 데이터 입력, 검증, 조회 또는 변환 흐름이 어떻게 드러나는지 설명해주세요.",
                "relatedFiles": [file["path"] for file in data_files] or [first_path],
                "evidenceSnippets": compact_evidence_list(data_evidence or [pick_evidence_for_path(evidence_snippets, file["path"]) for file in data_files] or [pick_evidence_for_path(evidence_snippets, first_path)]),
            },
            {
                "id": "q4",
                "type": question_types[3 % len(question_types)],
                "question": f"{first_path}의 동작을 수정할 때 함께 확인해야 할 영향 범위와 파일은 무엇인가요?",
                "relatedFiles": [file["path"] for file in impact_files] or [first_path],
                "evidenceSnippets": compact_evidence_list([pick_evidence_for_path(evidence_snippets, file["path"]) for file in impact_files] or [pick_evidence_for_path(evidence_snippets, first_path)]),
            },
            {
                "id": "q5",
                "type": question_types[4 % len(question_types)],
                "question": f"면접이나 코드리뷰에서 {second_path}를 근거로 설계 의도와 위험 지점을 어떻게 설명하겠습니까?",
                "relatedFiles": [file["path"] for file in interview_files] or [second_path],
                "evidenceSnippets": compact_evidence_list([pick_evidence_for_path(evidence_snippets, file["path"]) for file in interview_files] or [pick_evidence_for_path(evidence_snippets, second_path)]),
            },
        ],
    }


def fallback_question_subject(snippet: dict) -> str:
    path = str(snippet.get("path") or "핵심 파일")
    title = str(snippet.get("title") or "")
    scope = title.split("·", 1)[1].strip() if "·" in title else title.replace(path, "", 1).strip(" ·-")
    if not scope or scope == "file overview":
        return f"{path}의 코드 조각"
    if re.fullmatch(r"GET|POST|PUT|PATCH|DELETE", scope):
        return f"{path}의 {scope} handler"
    return f"{path}의 {scope} 코드"


def build_repo_evidence_snippets(files: list[dict], focus: str, question_targets: list[str]) -> list[dict]:
    guaranteed = []
    extras = []
    for file in files:
        file_snippets = to_repo_file_evidence(file, focus, question_targets)
        if file_snippets:
            guaranteed.append(file_snippets[0])
            extras.extend(file_snippets[1:])

    selected = [*guaranteed, *sorted(extras, key=lambda item: item["score"], reverse=True)]
    return dedupe_evidence(selected)[: max(MAX_EVIDENCE_SNIPPETS, len(guaranteed))]


def to_repo_file_evidence(file: dict, focus: str, question_targets: list[str]) -> list[dict]:
    path = str(file.get("path") or "unknown")
    content = redact_secrets(str(file.get("content") or ""))
    if not content:
        return [make_repo_evidence(file, 0, "file unavailable", "", focus, question_targets)]

    chunks = rank_repo_chunks([*extract_symbol_chunks(content)[:3], *extract_keyword_chunks(content, path)[:3]], path)
    if not any(excerpt.strip() for _, excerpt in chunks):
        chunks = [("file overview", slice_around(content, 0, MAX_REPO_SNIPPET_LENGTH))]
    return [
        make_repo_evidence(file, index, title, excerpt, focus, question_targets)
        for index, (title, excerpt) in enumerate(chunks)
        if excerpt.strip()
    ]


def extract_symbol_chunks(content: str) -> list[tuple[str, str]]:
    patterns = [
        r"^\s*(export\s+)?(async\s+)?function\s+([A-Za-z0-9_]+)",
        r"^\s*(export\s+)?(default\s+)?class\s+([A-Za-z0-9_]+)",
        r"^\s*(export\s+)?const\s+([A-Za-z0-9_]+)\s*=",
        r"^\s*def\s+([A-Za-z0-9_]+)\s*\(",
        r"^\s*class\s+([A-Za-z0-9_]+)",
        r"^\s*(public|private|protected)?\s*(static\s+)?[A-Za-z0-9_<>, ?\[\]]+\s+([A-Za-z0-9_]+)\s*\(",
    ]
    matches = []
    for pattern in patterns:
        for match in re.finditer(pattern, content, re.M):
            symbol = next((group for group in reversed(match.groups()) if group), "symbol")
            matches.append((match.start(), symbol))
    chunks = []
    seen = set()
    for start, symbol in sorted(matches, key=lambda item: item[0]):
        key = (start, symbol)
        if key in seen:
            continue
        seen.add(key)
        chunks.append((symbol, slice_around(content, start, MAX_REPO_SNIPPET_LENGTH)))
        if len(chunks) >= 6:
            break
    return chunks


def rank_repo_chunks(chunks: list[tuple[str, str]], path: str) -> list[tuple[str, str]]:
    return [
        chunk
        for _, chunk in sorted(
            enumerate(chunks),
            key=lambda item: (repo_chunk_priority(item[1][0], item[1][1], path), item[0]),
        )
    ]


def repo_chunk_priority(title: str, excerpt: str, path: str) -> int:
    if re.fullmatch(r"GET|POST|PUT|PATCH|DELETE", title):
        return 0
    if is_entrypoint_file(path) and re.search(r"\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b", excerpt):
        return 1
    if title in {"runtime", "dynamic", "revalidate", "preferredRegion", "maxDuration", "fetchCache"}:
        return 8
    if title in {"request flow", "data flow", "error handling"}:
        return 3
    if title == "configuration":
        return 7
    if title == "file overview":
        return 9
    return 2


def extract_keyword_chunks(content: str, path: str) -> list[tuple[str, str]]:
    keyword_groups = [
        ("error handling", r"\b(except|catch|raise|throw|HTTPError|URLError|ValueError|Exception)\b"),
        ("request flow", r"\b(Request|fetch|urlopen|router|route|controller|handler|GET|POST|PUT|PATCH|DELETE)\b"),
        ("data flow", r"\b(schema|model|repository|entity|database|query|save|create|update|delete|find|fetch|parse|validate)\b"),
    ]
    if is_config_file(path):
        keyword_groups.insert(0, ("configuration", r"\b(os\.getenv|BaseSettings|Settings|config|env|secret|token|key)\b"))

    chunks = []
    seen_ranges = set()
    for title, pattern in keyword_groups:
        for match in re.finditer(pattern, content, re.I):
            start = max(match.start() - MAX_REPO_SNIPPET_LENGTH // 2, 0)
            range_key = start // 160
            if range_key in seen_ranges:
                continue
            seen_ranges.add(range_key)
            chunks.append((title, slice_around(content, match.start(), MAX_REPO_SNIPPET_LENGTH)))
            break
    return chunks


def make_repo_evidence(file: dict, index: int, title: str, excerpt: str, focus: str, question_targets: list[str]) -> dict:
    path = str(file.get("path") or "unknown")
    return {
        "id": f"{sanitize_evidence_id(path)}:{index}",
        "path": path,
        "title": f"{path} · {title}",
        "reason": infer_evidence_reason(path, title, excerpt),
        "excerpt": excerpt[:MAX_REPO_SNIPPET_LENGTH],
        "kind": file_layer(path),
        "score": score_file(file, focus, question_targets) + score_repo_excerpt(title, excerpt),
    }


def score_repo_excerpt(title: str, excerpt: str) -> int:
    score = min(len(excerpt), MAX_REPO_SNIPPET_LENGTH) // 100
    if title == "file overview":
        score -= 24
    else:
        score += 18
    if re.search(r"function|class|def |return|async|await|fetch|axios|router|route|controller|service|repository", excerpt, re.I):
        score += 16
    return score


def infer_evidence_reason(path: str, title: str, excerpt: str) -> str:
    if title == "file overview":
        return infer_file_reason(path)

    text = f"{path}\n{title}\n{excerpt}"
    if re.search(r"\b(GET|POST|PUT|PATCH|DELETE|Request|Response|APIRouter|FastAPI|fetch\w*|urlopen|axios|NextRequest|NextResponse)\b|route|router|controller|handler|api/", text, re.I):
        return "요청 처리와 API/서비스 연결 흐름을 확인할 수 있는 코드 조각"
    if re.search(r"\b(schema|model|repository|entity|database|query\w*|save\w*|create\w*|update\w*|delete\w*|find\w*|fetch\w*|parse\w*|validate\w*)\b", text, re.I):
        return "데이터 입력, 검증, 조회 또는 변환 흐름을 확인할 수 있는 코드 조각"
    if re.search(r"\b(except|catch|raise|throw|HTTPError|URLError|ValueError|Exception)\b", text, re.I):
        return "예외 처리와 실패 경계를 확인할 수 있는 코드 조각"
    return "선택된 함수나 클래스의 책임을 확인할 수 있는 코드 조각"


def sanitize_evidence_id(path: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", path).strip("-") or "unknown"


def pick_evidence_for_path(snippets: list[dict], path: str) -> dict | None:
    return next((snippet for snippet in snippets if snippet.get("path") == path), None)


def pick_evidence_by_capability(snippets: list[dict], predicate, layers: list[str], limit: int) -> list[dict]:
    selected = []
    for layer in layers:
        for snippet in snippets:
            if snippet.get("kind") == layer and predicate(snippet) and snippet not in selected:
                selected.append(snippet)
                break
        if len(selected) >= limit:
            return selected
    for snippet in snippets:
        if predicate(snippet) and snippet not in selected:
            selected.append(snippet)
        if len(selected) >= limit:
            break
    return selected


def evidence_paths(snippets: list[dict]) -> list[str]:
    return list(dict.fromkeys(str(snippet.get("path")) for snippet in snippets if snippet.get("path")))


def supports_request_flow_evidence(snippet: dict) -> bool:
    path = str(snippet.get("path") or "")
    kind = str(snippet.get("kind") or "")
    text = f"{path}\n{snippet.get('title', '')}\n{snippet.get('excerpt', '')}"
    if kind == "config" and re.search(r"package\.json|config|env|settings|docker", path, re.I):
        return False
    return bool(
        is_entrypoint_file(path)
        or re.search(r"\b(GET|POST|PUT|PATCH|DELETE)\b|\b(APIRouter|FastAPI)\s*\(|\b(fetch\w*|urlopen|axios|NextRequest|NextResponse)\b|request\s*[:.]|response\s*[:.]", text, re.I)
    )


def supports_request_or_service_evidence(snippet: dict) -> bool:
    return supports_request_flow_evidence(snippet) or is_request_helper_evidence(snippet)


def is_request_helper_evidence(snippet: dict) -> bool:
    if str(snippet.get("kind") or "") != "service":
        return False
    text = f"{snippet.get('path', '')}\n{snippet.get('title', '')}\n{snippet.get('excerpt', '')}"
    if re.search(r"\bdocs?_enabled|openapi|redoc|swagger|cors|allowed_origins\b", text, re.I):
        return False
    return bool(re.search(r"\b(parse\w*|validate\w*|fetch\w*|build\w*|analyze\w*|evaluate\w*|create\w*|update\w*|delete\w*|request\.json|urlparse|urlopen|axios)\b", text, re.I))


def supports_data_flow_evidence(snippet: dict) -> bool:
    path = str(snippet.get("path") or "")
    kind = str(snippet.get("kind") or "")
    text = f"{path}\n{snippet.get('title', '')}\n{snippet.get('excerpt', '')}"
    if kind == "config":
        return False
    if re.search(r"tally|analytics|track\(", text, re.I) and not re.search(r"\b(fetch|axios|save|query|repository|database|request\.json|FormData|localStorage)\b", text, re.I):
        return False
    return bool(
        kind in {"data", "service", "entry"}
        and re.search(
            r"\b(schema|model|repository|entity|database|query\w*|save\w*|create\w*|update\w*|delete\w*|find\w*|fetch\w*|parse\w*|validate\w*|request\.json|response\.json|json\.loads|FormData|localStorage)\b",
            text,
            re.I,
        )
    )


def dedupe_evidence(snippets: list[dict]) -> list[dict]:
    result = []
    seen = set()
    for snippet in snippets:
        snippet_id = snippet.get("id")
        if not snippet_id or snippet_id in seen:
            continue
        seen.add(snippet_id)
        result.append(snippet)
    return result


def compact_evidence_list(snippets: list[dict | None]) -> list[dict]:
    result = []
    seen = set()
    for snippet in snippets:
        if not snippet:
            continue
        key = evidence_identity(snippet)
        if key in seen:
            continue
        seen.add(key)
        result.append({key: snippet[key] for key in ["id", "path", "title", "reason", "excerpt", "kind"] if key in snippet})
    return result[:3]


def evidence_identity(snippet: dict) -> str:
    path = str(snippet.get("path") or "")
    title = str(snippet.get("title") or "")
    scope = title.split("·", 1)[1].strip() if "·" in title else title.replace(path, "", 1).strip(" ·-")
    return f"{path}:{scope or str(snippet.get('id') or '')}"


def select_context_files(files: list[dict], focus: str, question_targets: list[str]) -> list[dict]:
    runtime_files = [file for file in files if not is_test_file(file["path"])]
    ranked = sorted(runtime_files, key=lambda file: score_file(file, focus, question_targets), reverse=True)

    if focus == "balanced":
        selected = select_diverse_files(ranked, ["entry", "service", "data", "ui", "config"], per_layer=3)
        selected += [file for file in ranked if file not in selected][:MAX_CONTEXT_FILES]
        return selected[:MAX_CONTEXT_FILES]

    focused = [file for file in ranked if matches_focus(file["path"], focus)]
    primary = select_diverse_files(focused, ["entry", "service", "data", "ui", "config"], per_layer=3)[:11]
    primary += [file for file in focused if file not in primary][:11]
    primary = primary[:11]
    complement = select_diverse_files([file for file in ranked if file not in primary], ["entry", "service", "data", "ui", "config"], per_layer=1)[:4]
    return (primary + complement)[:MAX_CONTEXT_FILES]


def score_file(file: dict, focus: str, question_targets: list[str]) -> int:
    path = file["path"]
    content = file.get("content", "")
    score = 0
    if re.search(r"README|package\.json|build\.gradle|pom\.xml|Dockerfile", path, re.I):
        score += 20
    if re.search(r"route|router|controller|service|repository|entity|model|schema|auth|config", path, re.I):
        score += 24
    if re.search(r"(^|/)(src|app|pages|components|lib|server|routes|api)/", path, re.I):
        score += 12
    if matches_focus(path, focus):
        score += 18
    if is_test_file(path):
        score -= 35
    haystack = f"{path}\n{content[:4000]}".lower()
    for target in expand_targets(question_targets):
        if target in path.lower():
            score += 22
        if target in haystack:
            score += 12
    return score


def expand_targets(question_targets: list[str]) -> set[str]:
    terms = set()
    for target in question_targets:
        normalized = target.lower()
        terms.add(normalized)
        terms.update(token for token in re.split(r"[\s/_-]+", normalized) if len(token) >= 2)
        if re.search(r"로그인|인증|회원|계정|권한|보안", target):
            terms.update({"auth", "login", "user", "account", "token", "security", "permission"})
        if re.search(r"ai|면접|질문|어시스턴트|assistant", target, re.I):
            terms.update({"ai", "interview", "question", "assistant", "gemini", "llm"})
    return terms


def to_file_summary(file: dict) -> dict:
    return {"path": file["path"], "reason": infer_file_reason(file["path"]), "excerpt": smart_excerpt(redact_secrets(file.get("content", "")))}


def smart_excerpt(content: str) -> str:
    normalized = content.replace("\r\n", "\n")
    if len(normalized) <= MAX_EXCERPT_LENGTH:
        return normalized
    head = normalized[:360]
    middle = slice_around(normalized, len(normalized) // 2, 360)
    tail = normalized[-360:]
    symbol = find_symbol_excerpt(normalized)
    sections = [f"[head]\n{head.strip()}", f"[middle]\n{middle.strip()}", f"[tail]\n{tail.strip()}"]
    if symbol:
        sections.append(f"[symbol]\n{symbol.strip()}")
    return "\n\n".join(sections)[:MAX_EXCERPT_LENGTH]


def slice_around(content: str, index: int, length: int) -> str:
    normalized = content.replace("\r\n", "\n")
    if len(normalized) <= length:
        return normalized

    start = max(index - length // 2, 0)
    end = min(start + length, len(normalized))
    if end == len(normalized):
        start = max(len(normalized) - length, 0)

    has_before = start > 0
    has_after = end < len(normalized)
    marker_overhead = 0
    if has_before:
        marker_overhead += len(OMITTED_BEFORE_MARKER) + 2
    if has_after:
        marker_overhead += len(OMITTED_AFTER_MARKER) + 2

    body_length = max(120, length - marker_overhead)
    start = max(index - body_length // 2, 0)
    end = min(start + body_length, len(normalized))
    if end == len(normalized):
        start = max(len(normalized) - body_length, 0)
    start, end = align_slice_to_lines(normalized, start, end, index)

    parts = []
    if start > 0:
        parts.append(OMITTED_BEFORE_MARKER)
    parts.append(normalized[start:end].strip("\n"))
    if end < len(normalized):
        parts.append(OMITTED_AFTER_MARKER)
    return "\n\n".join(parts)


def align_slice_to_lines(content: str, start: int, end: int, index: int) -> tuple[int, int]:
    if start > 0:
        next_newline = content.find("\n", start)
        if next_newline != -1 and next_newline < index:
            start = next_newline + 1
        else:
            start = content.rfind("\n", 0, index) + 1

    if end < len(content):
        previous_newline = content.rfind("\n", 0, end)
        if previous_newline > index:
            end = previous_newline
        else:
            next_newline = content.find("\n", index)
            end = len(content) if next_newline == -1 else next_newline

    if start >= end:
        line_start = content.rfind("\n", 0, index) + 1
        line_end = content.find("\n", index)
        return line_start, len(content) if line_end == -1 else line_end
    return start, end


def find_symbol_excerpt(content: str) -> str:
    patterns = [
        r"@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b",
        r"\bexport\s+(async\s+)?function\s+\w+",
        r"\bfunction\s+\w+\s*\(",
        r"\bclass\s+\w+",
    ]
    for pattern in patterns:
        match = re.search(pattern, content)
        if match and match.start() > 360:
            return slice_around(content, match.start(), 420)
    return ""


def summarize_tree(files: list[dict]) -> list[str]:
    folders = set()
    for file in files:
        parts = file["path"].split("/")
        folders.add(file["path"] if len(parts) == 1 else "/".join(parts[: min(len(parts) - 1, 2)]))
    return sorted(folders)[:30]


def parse_package(content: str) -> dict | None:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return None


def infer_stack(package_info: dict | None, files: list[dict]) -> list[str]:
    stack = set()
    dependencies = {}
    if package_info:
        dependencies.update(package_info.get("dependencies") or {})
        dependencies.update(package_info.get("devDependencies") or {})
    if "next" in dependencies:
        stack.add("Next.js")
    if "react" in dependencies:
        stack.add("React")
    if "typescript" in dependencies or any(file["path"].endswith((".ts", ".tsx")) for file in files):
        stack.add("TypeScript")
    if any(file["path"].endswith(".java") for file in files):
        stack.add("Java")
    if any("SpringApplication" in file.get("excerpt", "") or "@SpringBootApplication" in file.get("excerpt", "") for file in files):
        stack.add("Spring Boot")
    if any(file["path"].endswith(".py") for file in files):
        stack.add("Python")
    if any("FastAPI" in file.get("excerpt", "") or "from fastapi" in file.get("excerpt", "") for file in files):
        stack.add("FastAPI")
    return list(stack) or ["JavaScript/TypeScript"]


def infer_file_reason(path: str) -> str:
    if re.search(r"README", path, re.I):
        return "프로젝트 설명과 실행 방법을 확인할 수 있는 파일"
    if is_client_file(path):
        return "사용자 화면과 UI 흐름을 확인할 수 있는 파일"
    if is_config_file(path):
        return "기술 스택, 실행 설정, 배포 구성을 확인할 수 있는 파일"
    if re.search(r"route|router|controller|handler", path, re.I):
        return "요청 진입점과 API 흐름을 확인할 수 있는 파일"
    if re.search(r"service|usecase|domain|auth|security", path, re.I):
        return "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일"
    if re.search(r"repository|entity|model|schema|store|db|database|dao|mapper|prisma", path, re.I):
        return "데이터 모델과 저장소 접근 흐름을 확인할 수 있는 파일"
    return "프로젝트 구조 이해에 참고할 수 있는 파일"


def select_diverse_files(files: list[dict], layers: list[str], per_layer: int) -> list[dict]:
    selected = []
    for layer in layers:
        layer_files = [file for file in files if file_layer(file["path"]) == layer]
        for file in layer_files[:per_layer]:
            if file not in selected:
                selected.append(file)
    return selected


def pick_context_file(files: list[dict], layers: list[str]) -> dict | None:
    picked = pick_context_files(files, layers, 1)
    return picked[0] if picked else (files[0] if files else None)


def pick_structure_context_file(files: list[dict], request_files: list[dict]) -> dict:
    for request_file in request_files:
        path = request_file.get("path")
        if not path:
            continue
        matched = next((file for file in files if file["path"] == path), None)
        if matched and not is_contract_like_path(path):
            return matched
    return pick_context_file(files, ["entry", "service", "ui", "config"]) or {"path": "핵심 파일"}


def is_contract_like_path(path: str) -> bool:
    return bool(re.search(r"(^|/)(schemas?|models?|entities?|dto|types?)(/|$)|(?:schema|model|entity|dto|types?)\.", path, re.I))


def pick_context_files(files: list[dict], layers: list[str], limit: int) -> list[dict]:
    selected = []
    for layer in layers:
        for file in files:
            if file_layer(file["path"]) == layer and file not in selected:
                selected.append(file)
                if len(selected) >= limit:
                    return selected
    for file in files:
        if file not in selected:
            selected.append(file)
            if len(selected) >= limit:
                return selected
    return selected


def file_layer(path: str) -> str:
    if is_entrypoint_file(path):
        return "entry"
    if is_client_file(path):
        return "ui"
    if re.search(r"service|usecase|domain|interactor|manager|assistant", path, re.I):
        return "service"
    if re.search(r"repository|entity|model|schema|store|db|database|dao|mapper|prisma|migration", path, re.I):
        return "data"
    if is_config_file(path) or re.search(r"auth|security|middleware|error|exception", path, re.I):
        return "config"
    if is_test_file(path):
        return "test"
    return "other"


def matches_focus(path: str, focus: str) -> bool:
    if focus == "balanced":
        return True
    return is_client_file(path) if focus == "frontend" else is_server_file(path)


def is_client_file(path: str) -> bool:
    return bool(re.search(r"(^|/)(frontend|client|web|pages|components|views|screens|ui)(/|$)|(^|/)src/app/|\.(tsx|jsx|vue|svelte|astro)$", path, re.I))


def is_entrypoint_file(path: str) -> bool:
    return bool(
        re.search(r"(^|/)(app/api|src/app/api|pages/api|routes?|controllers?|endpoints?)/.+\.(py|ts|tsx|js|jsx|java|kt|go|rs)$", path, re.I)
        or re.search(r"(^|/)(route|router|controller|handler)\.(py|ts|tsx|js|jsx)$", path, re.I)
        or re.search(r"(^|/)[A-Za-z0-9_.-]*(route|router|controller|handler|endpoint)[A-Za-z0-9_.-]*\.(py|ts|tsx|js|jsx|java|kt|go|rs)$", path, re.I)
    )


def is_server_file(path: str) -> bool:
    return bool(re.search(r"(^|/)(backend|server|api|routes|controllers?|services?|repositories?|entities?|models?|domain|infra|config)(/|$)|\.(java|kt|go|py|rb|php|cs|rs)$", path, re.I))


def is_config_file(path: str) -> bool:
    return bool(re.search(r"config|\.config\.|package\.json|build\.gradle|settings\.gradle|pom\.xml|application\.(yml|yaml|properties)|docker", path, re.I))


def is_test_file(path: str) -> bool:
    return bool(re.search(r"(^|/)(__tests__|test|tests|spec)(/|$)|\.(test|spec)\.(ts|tsx|js|jsx|java|kt)$", path, re.I))
