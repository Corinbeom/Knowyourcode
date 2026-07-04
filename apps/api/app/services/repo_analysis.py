from datetime import datetime, timezone
import json
import re

QUESTION_TYPES = ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"]
MAX_CONTEXT_FILES = 15
MAX_EXCERPT_LENGTH = 1600


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
    context_files = [to_file_summary(file) for file in select_context_files(files, focus, question_targets)]
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
        "tree": tree,
        "packageInfo": package_info,
    }


def build_fallback_repo_analysis(context: dict) -> dict:
    key_files = context["contextFiles"][:6]
    first_path = key_files[0]["path"] if key_files else "핵심 파일"
    second_path = key_files[1]["path"] if len(key_files) > 1 else first_path
    third_path = key_files[2]["path"] if len(key_files) > 2 else second_path
    question_types = context["questionTypes"]

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
                "question": f"{first_path}의 역할을 기준으로 주요 구조를 설명해주세요.",
                "relatedFiles": [first_path],
            },
            {
                "id": "q2",
                "type": question_types[1 % len(question_types)],
                "question": f"{second_path}에서 시작되는 요청 흐름을 설명해주세요.",
                "relatedFiles": [second_path],
            },
            {
                "id": "q3",
                "type": question_types[2 % len(question_types)],
                "question": f"{third_path}에서 데이터가 어떻게 전달되는지 설명해주세요.",
                "relatedFiles": [third_path],
            },
            {
                "id": "q4",
                "type": question_types[3 % len(question_types)],
                "question": f"{first_path}를 수정하면 어떤 영향 범위를 확인해야 하나요?",
                "relatedFiles": [first_path],
            },
            {
                "id": "q5",
                "type": question_types[4 % len(question_types)],
                "question": f"면접에서 {second_path}를 근거로 핵심 구조를 어떻게 설명하겠습니까?",
                "relatedFiles": [second_path],
            },
        ],
    }


def select_context_files(files: list[dict], focus: str, question_targets: list[str]) -> list[dict]:
    runtime_files = [file for file in files if not is_test_file(file["path"])]
    ranked = sorted(runtime_files, key=lambda file: score_file(file, focus, question_targets), reverse=True)

    if focus == "balanced":
        frontend = [file for file in ranked if is_client_file(file["path"])][:5]
        backend = [file for file in ranked if is_server_file(file["path"])][:5]
        selected = frontend + [file for file in backend if file not in frontend]
        selected += [file for file in ranked if file not in selected][:5]
        return selected[:MAX_CONTEXT_FILES]

    primary = [file for file in ranked if matches_focus(file["path"], focus)][:11]
    complement = [file for file in ranked if file not in primary][:4]
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
    return {"path": file["path"], "reason": infer_file_reason(file["path"]), "excerpt": smart_excerpt(file.get("content", ""))}


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
    start = max(index - length // 2, 0)
    return content[start : start + length]


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
    if is_config_file(path):
        return "기술 스택, 실행 설정, 배포 구성을 확인할 수 있는 파일"
    if re.search(r"route|router|controller|handler", path, re.I):
        return "요청 진입점과 API 흐름을 확인할 수 있는 파일"
    if re.search(r"service|usecase|domain|auth|security", path, re.I):
        return "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일"
    if re.search(r"repository|entity|model|schema|store|db|database|dao|mapper|prisma", path, re.I):
        return "데이터 모델과 저장소 접근 흐름을 확인할 수 있는 파일"
    if is_client_file(path):
        return "사용자 화면과 UI 흐름을 확인할 수 있는 파일"
    return "프로젝트 구조 이해에 참고할 수 있는 파일"


def matches_focus(path: str, focus: str) -> bool:
    if focus == "balanced":
        return True
    return is_client_file(path) if focus == "frontend" else is_server_file(path)


def is_client_file(path: str) -> bool:
    return bool(re.search(r"(^|/)(frontend|client|web|app|pages|components|views|screens|ui)(/|$)|\.(tsx|jsx|vue|svelte|astro)$", path, re.I))


def is_server_file(path: str) -> bool:
    return bool(re.search(r"(^|/)(backend|server|api|routes|controllers?|services?|repositories?|entities?|models?|domain|infra|config)(/|$)|\.(java|kt|go|py|rb|php|cs|rs)$", path, re.I))


def is_config_file(path: str) -> bool:
    return bool(re.search(r"config|\.config\.|package\.json|build\.gradle|settings\.gradle|pom\.xml|application\.(yml|yaml|properties)|docker", path, re.I))


def is_test_file(path: str) -> bool:
    return bool(re.search(r"(^|/)(__tests__|test|tests|spec)(/|$)|\.(test|spec)\.(ts|tsx|js|jsx|java|kt)$", path, re.I))
