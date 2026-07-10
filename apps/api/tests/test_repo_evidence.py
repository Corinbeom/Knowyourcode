import unittest

from app.services.repo_analysis import build_fallback_repo_analysis, build_repo_static_context, extract_keyword_chunks, file_layer, infer_file_reason, slice_around
from app.services.llm import compact_evidence, enforce_repo_question_quality, evidence_snippets_connected, is_repo_question_evidence_aligned, question_capability_gap, refine_repo_question_evidence


def sample_repo():
    return {"owner": "acme", "repo": "demo", "branch": "main", "url": "https://github.com/acme/demo"}


class RepoEvidenceTest(unittest.TestCase):
    def test_repo_static_context_builds_symbol_evidence(self):
        context = build_repo_static_context(
            sample_repo(),
            [
                {
                    "path": "src/app/api/users/route.ts",
                    "content": "export async function GET() {\n  return fetchUsers();\n}\n\nexport async function POST() {\n  return createUser();\n}",
                    "size": 120,
                },
                {
                    "path": "src/lib/user-service.ts",
                    "content": "export function fetchUsers() {\n  return repository.findMany();\n}",
                    "size": 80,
                },
            ],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        self.assertTrue(context["evidenceSnippets"])
        self.assertTrue(any(snippet["path"] == "src/app/api/users/route.ts" for snippet in context["evidenceSnippets"]))
        self.assertTrue(any("GET" in snippet["title"] for snippet in context["evidenceSnippets"]))

    def test_repo_symbol_evidence_precedes_file_overview(self):
        context = build_repo_static_context(
            sample_repo(),
            [
                {
                    "path": "src/app/api/evaluate-quiz/route.ts",
                    "content": (
                        "import { NextResponse } from 'next/server';\n"
                        "import { proxy } from '@/lib/proxy';\n\n"
                        "export async function POST(request: Request) {\n"
                        "  const payload = await request.json();\n"
                        "  return proxy('/evaluate', payload);\n"
                        "}\n"
                    ),
                    "size": 220,
                }
            ],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        first = next(snippet for snippet in context["evidenceSnippets"] if snippet["path"] == "src/app/api/evaluate-quiz/route.ts")

        self.assertIn("· POST", first["title"])
        self.assertNotIn("file overview", first["title"])
        self.assertIn("코드 조각", first["reason"])

    def test_repo_route_handler_precedes_runtime_config_evidence(self):
        context = build_repo_static_context(
            sample_repo(),
            [
                {
                    "path": "apps/web/src/app/api/analyze-commit/route.ts",
                    "content": (
                        "export const runtime = \"nodejs\";\n\n"
                        "import { NextResponse } from 'next/server';\n"
                        "import { buildCommitStaticContext } from '@/lib/commit-analysis';\n\n"
                        "export async function POST(request: Request) {\n"
                        "  const payload = await request.json();\n"
                        "  const context = buildCommitStaticContext(payload.files);\n"
                        "  return NextResponse.json({ context });\n"
                        "}\n"
                    ),
                    "size": 320,
                }
            ],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )
        first = next(snippet for snippet in context["evidenceSnippets"] if snippet["path"] == "apps/web/src/app/api/analyze-commit/route.ts")
        runtime = next(snippet for snippet in context["evidenceSnippets"] if "· runtime" in snippet["title"])

        self.assertIn("· POST", first["title"])
        self.assertNotIn("· runtime", first["title"])
        self.assertEqual(first["quality"], "strong")
        self.assertEqual(runtime["quality"], "conditional")

    def test_runtime_scope_is_not_accepted_as_request_flow_evidence(self):
        runtime_evidence = {
            "id": "route.ts:runtime",
            "path": "apps/web/src/app/api/analyze-commit/route.ts",
            "title": "apps/web/src/app/api/analyze-commit/route.ts · runtime",
            "reason": "요청 처리와 API 연결 흐름",
            "excerpt": "export const runtime = 'nodejs';\n\nexport async function POST(request: Request) {\n  return proxy(request);\n}",
            "kind": "entry",
        }
        post_evidence = {
            **runtime_evidence,
            "id": "route.ts:post",
            "title": "apps/web/src/app/api/analyze-commit/route.ts · POST",
        }
        question = {
            "id": "q2",
            "type": "요청 흐름",
            "question": "route.ts의 POST handler는 인증 후 분석 요청을 어떻게 처리하나요?",
            "relatedFiles": [runtime_evidence["path"]],
            "evidenceSnippets": [runtime_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [runtime_evidence, post_evidence])

        self.assertEqual(refined[0]["evidenceSnippets"][0]["title"], post_evidence["title"])
        self.assertNotIn(runtime_evidence, refined[0]["evidenceSnippets"])

    def test_repo_first_question_prefers_entry_over_schema_contract(self):
        context = build_repo_static_context(
            sample_repo(),
            [
                {
                    "path": "apps/api/app/schemas/repo.py",
                    "content": "class AnalyzeRepoRequest(BaseModel):\n    url: str\n    focus: str | None = None\n",
                    "size": 120,
                },
                {
                    "path": "apps/api/app/api/repo.py",
                    "content": (
                        "from app.schemas.repo import AnalyzeRepoRequest\n\n"
                        "def analyze_repo(payload: AnalyzeRepoRequest):\n"
                        "    context = build_repo_static_context(payload)\n"
                        "    return generate_repo_analysis(context)\n"
                    ),
                    "size": 220,
                },
            ],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        analysis = build_fallback_repo_analysis(context)

        self.assertEqual(analysis["questions"][0]["relatedFiles"], ["apps/api/app/api/repo.py"])
        self.assertIn("analyze_repo", analysis["questions"][0]["question"])
        self.assertNotIn("AnalyzeRepoRequest 모델", analysis["questions"][0]["question"])

    def test_slice_around_marks_omitted_code(self):
        content = "\n".join(f"const value{index} = {index};" for index in range(100))
        excerpt = slice_around(content, content.index("value50"), 240)

        self.assertIn("이전 코드 생략", excerpt)
        self.assertIn("이후 코드 생략", excerpt)
        self.assertIn("value50", excerpt)
        code_lines = [line for line in excerpt.splitlines() if line and "코드 생략" not in line]
        self.assertTrue(all(line.startswith("const value") for line in code_lines))

    def test_symbol_evidence_keeps_later_prompt_body(self):
        padding = "\n".join(f"    value_{index} = normalize(answer)" for index in range(45))
        content = (
            "def evaluate_answer(question, answer):\n"
            "    if not answer:\n        return fallback\n"
            f"{padding}\n"
            "    prompt = f\"\"\"Question: {question}\\nAnswer: {answer}\\nRelevant code excerpts\"\"\"\n"
            "    return call_model(prompt)\n"
        )
        context = build_repo_static_context(
            sample_repo(),
            [{"path": "apps/api/app/services/evaluation.py", "content": content, "size": len(content)}],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        snippet = next(item for item in context["evidenceSnippets"] if "evaluate_answer" in item["title"])
        self.assertTrue(snippet["excerpt"].startswith("def evaluate_answer"))
        self.assertIn("Relevant code excerpts", snippet["excerpt"])
        self.assertIn("return call_model(prompt)", snippet["excerpt"])

    def test_keyword_evidence_starts_at_nearest_function_declaration(self):
        content = (
            "def evaluate_answer(question, answer):\n"
            "    body = validate(answer)\n"
            "    result = call_model(body)\n"
            "    return result\n"
        )

        data_chunk = next(excerpt for title, excerpt in extract_keyword_chunks(content, "apps/api/app/services/evaluation.py") if title == "data flow")

        self.assertTrue(data_chunk.startswith("def evaluate_answer"))
        self.assertIn("body = validate(answer)", data_chunk)

    def test_url_symbol_evidence_starts_at_function_and_contains_all_constraints(self):
        prefix = "\n".join(f"# unrelated line {index}" for index in range(180))
        parser = (
            "def parse_github_url(value):\n"
            "    parsed = urlparse(value)\n"
            "    if parsed.scheme != 'https':\n        raise ValueError('https only')\n"
            "    if parsed.hostname != 'github.com':\n        raise ValueError('github only')\n"
            "    return parsed.path\n"
        )
        content = f"{prefix}\n{parser}"
        context = build_repo_static_context(
            sample_repo(),
            [{"path": "apps/api/app/services/github_repo.py", "content": content, "size": len(content)}],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        snippet = next(item for item in context["evidenceSnippets"] if "parse_github_url" in item["title"])
        code_lines = [line for line in snippet["excerpt"].splitlines() if line and "코드 생략" not in line]
        self.assertEqual(code_lines[0], "def parse_github_url(value):")
        self.assertIn("parsed.scheme != 'https'", snippet["excerpt"])
        self.assertIn("parsed.hostname != 'github.com'", snippet["excerpt"])
        self.assertIn("return parsed.path", snippet["excerpt"])
        self.assertTrue(snippet["excerpt"].startswith("... 이전 코드 생략 ..."))

    def test_request_flow_rejects_unconnected_frontend_and_python_service(self):
        route = {
            "id": "route:POST",
            "path": "apps/web/src/app/api/analyze/route.ts",
            "title": "apps/web/src/app/api/analyze/route.ts · POST",
            "reason": "Next.js 요청 진입점",
            "excerpt": "export async function POST(request) { return fetch(backendUrl); }",
            "kind": "entry",
            "quality": "strong",
        }
        service = {
            "id": "repo-analysis:build",
            "path": "apps/api/app/services/repo_analysis.py",
            "title": "apps/api/app/services/repo_analysis.py · build_repo_static_context",
            "reason": "Python 분석 서비스",
            "excerpt": "def build_repo_static_context(files):\n    return select_context_files(files)",
            "kind": "service",
            "quality": "strong",
        }

        self.assertFalse(evidence_snippets_connected([route, service]))

        relationship_question = {
            "type": "구조 이해",
            "question": "route.ts의 POST handler와 build_repo_static_context 역할과 연결 흐름을 설명해주세요.",
            "evidenceSnippets": [route, service],
        }
        self.assertIn("추적 가능한", question_capability_gap(relationship_question))

        guarded = enforce_repo_question_quality(
            [{"id": "q1", "type": "구조 이해", "question": relationship_question["question"], "relatedFiles": [route["path"], service["path"]], "evidenceSnippets": [route, service]}],
            [],
            [route, service],
        )
        self.assertEqual(len(guarded[0]["evidenceSnippets"]), 1)
        self.assertNotIn("연결 흐름", guarded[0]["question"])

        impact_guarded = enforce_repo_question_quality(
            [{"id": "q4", "type": "변경 영향도", "question": "build_repo_static_context를 수정할 때 route.ts의 POST handler까지 어떤 영향이 이어질 수 있나요?", "relatedFiles": [service["path"], route["path"]], "evidenceSnippets": [service, route]}],
            [],
            [route, service],
        )
        self.assertEqual(len(impact_guarded[0]["evidenceSnippets"]), 1)
        self.assertNotIn("route.ts의 POST handler까지", impact_guarded[0]["question"])

    def test_request_flow_allows_traceable_middle_handler_chain(self):
        route = {
            "path": "apps/web/src/app/api/analyze-commit/route.ts",
            "title": "apps/web/src/app/api/analyze-commit/route.ts · POST",
            "excerpt": "export async function POST(request) { return fetch('/analyze-commit'); }",
        }
        handler = {
            "path": "apps/api/app/api/commit.py",
            "title": "apps/api/app/api/commit.py · analyze_commit",
            "excerpt": "@router.post('/analyze-commit')\ndef analyze_commit(payload):\n    return build_commit_static_context(payload)",
        }
        service = {
            "path": "apps/api/app/services/commit_analysis.py",
            "title": "apps/api/app/services/commit_analysis.py · build_commit_static_context",
            "excerpt": "def build_commit_static_context(changes):\n    return select_changes(changes)",
        }
        question = {
            "type": "요청 흐름",
            "question": "route.ts에서 commit.py를 거쳐 build_commit_static_context까지 요청 처리가 어떻게 이어지나요?",
            "evidenceSnippets": [route, service, handler],
        }

        self.assertTrue(evidence_snippets_connected([route, service, handler]))
        self.assertIsNone(question_capability_gap(question))

    def test_quality_guard_avoids_reusing_same_path_and_scope(self):
        first = {
            "id": "evaluation.py:evaluate_answer",
            "path": "apps/api/app/services/evaluation.py",
            "title": "apps/api/app/services/evaluation.py · evaluate_answer",
            "reason": "단일 답변 평가",
            "excerpt": "def evaluate_answer(answer):\n    return grade(answer)",
            "kind": "service",
            "quality": "strong",
        }
        alternate = {
            **first,
            "id": "evaluation.py:evaluate_quiz",
            "title": "apps/api/app/services/evaluation.py · evaluate_quiz",
            "reason": "전체 퀴즈 평가",
            "excerpt": "def evaluate_quiz(answers):\n    return aggregate(answers)",
        }
        questions = [
            {"id": "q3", "type": "데이터 흐름", "question": "evaluate_answer가 답변을 어떻게 평가하나요?", "relatedFiles": [first["path"]], "evidenceSnippets": [first]},
            {"id": "q4", "type": "변경 영향도", "question": "evaluate_answer 변경 시 어떤 영향을 확인하나요?", "relatedFiles": [first["path"]], "evidenceSnippets": [first]},
        ]

        guarded = enforce_repo_question_quality(questions, questions, [first, alternate])

        self.assertEqual(guarded[0]["evidenceSnippets"][0]["id"], first["id"])
        self.assertEqual(guarded[1]["evidenceSnippets"][0]["id"], alternate["id"])

    def test_repo_question_evidence_dedupes_same_path_and_scope(self):
        first = {
            "id": "src-app-api-users-route.ts:0",
            "path": "src/app/api/users/route.ts",
            "title": "src/app/api/users/route.ts · POST",
            "reason": "요청 처리와 API/서비스 연결 흐름을 확인할 수 있는 코드 조각",
            "excerpt": "export async function POST(request: Request) { return createUser(); }",
            "kind": "entry",
        }
        duplicate = {**first, "id": "src-app-api-users-route.ts:1"}
        other = {**first, "id": "src-app-api-users-route.ts:2", "title": "src/app/api/users/route.ts · GET"}

        compacted = compact_evidence([first, duplicate, other])

        self.assertEqual([snippet["title"] for snippet in compacted], ["src/app/api/users/route.ts · POST", "src/app/api/users/route.ts · GET"])

    def test_fallback_repo_questions_all_have_evidence(self):
        context = build_repo_static_context(
            sample_repo(),
            [
                {
                    "path": "src/app/api/users/route.ts",
                    "content": "export async function GET() {\n  return fetchUsers();\n}",
                    "size": 80,
                }
            ],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        analysis = build_fallback_repo_analysis(context)

        self.assertGreaterEqual(len(analysis["questions"]), 3)
        self.assertLessEqual(len(analysis["questions"]), 5)
        self.assertTrue(all(question["evidenceSnippets"] for question in analysis["questions"]))

    def test_keyword_evidence_prefers_error_handling_region(self):
        context = build_repo_static_context(
            sample_repo(),
            [
                {
                    "path": "apps/api/app/services/github_commit.py",
                    "content": (
                        "def fetch_commit_changes(commit_input):\n"
                        "    api_url = 'https://api.github.com/repos/x/y/commits/z'\n"
                        "    request = Request(api_url)\n"
                        "    with urlopen(request, timeout=20) as response:\n"
                        "        data = json.loads(response.read().decode('utf-8'))\n"
                        "    return data\n\n"
                        "def parse_result(data):\n"
                        "    try:\n"
                        "        return normalize(data)\n"
                        "    except HTTPError as exc:\n"
                        "        if exc.code == 404:\n"
                        "            raise ValueError('커밋을 찾을 수 없습니다.')\n"
                        "        raise\n"
                    ),
                    "size": 400,
                }
            ],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        error_snippet = next((snippet for snippet in context["evidenceSnippets"] if "error handling" in snippet["title"]), None)

        self.assertIsNotNone(error_snippet)
        self.assertIn("except HTTPError", error_snippet["excerpt"])
        self.assertIn("raise ValueError", error_snippet["excerpt"])

    def test_repo_refine_rejects_generic_data_question_with_auth_only_evidence(self):
        auth_evidence = {
            "id": "backend-auth.ts:0",
            "path": "apps/web/src/lib/backend-auth.ts",
            "title": "apps/web/src/lib/backend-auth.ts requireBackendAuth",
            "reason": "인증 흐름을 확인할 수 있는 파일",
            "excerpt": "export async function requireBackendAuth() { return token; }",
            "kind": "config",
        }
        service_evidence = {
            "id": "github_repo.py:0",
            "path": "apps/api/app/services/github_repo.py",
            "title": "apps/api/app/services/github_repo.py fetch_repo_files",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def fetch_repo_files(repo):\n    data = request_repo_tree(repo)\n    return parse_files(data)",
            "kind": "service",
        }
        question = {
            "id": "q3",
            "type": "데이터 흐름",
            "question": "데이터가 생성, 검증, 저장 또는 조회되는 흐름을 관련 파일 기준으로 설명해주세요.",
            "relatedFiles": ["apps/web/src/lib/backend-auth.ts"],
            "evidenceSnippets": [auth_evidence],
        }
        fallback = [
            {
                **question,
                "question": "apps/api/app/services/github_repo.py에서 데이터 조회와 변환 흐름이 어떻게 드러나는지 설명해주세요.",
                "relatedFiles": ["apps/api/app/services/github_repo.py"],
                "evidenceSnippets": [service_evidence],
            }
        ]

        refined = refine_repo_question_evidence([question], fallback, [auth_evidence, service_evidence])

        self.assertEqual(refined[0]["relatedFiles"], ["apps/api/app/services/github_repo.py"])
        self.assertEqual(refined[0]["evidenceSnippets"][0]["id"], service_evidence["id"])

    def test_repo_refine_narrows_broad_structure_question_for_single_route_evidence(self):
        route_evidence = {
            "id": "route.ts:0",
            "path": "src/app/api/evaluate-quiz/route.ts",
            "title": "src/app/api/evaluate-quiz/route.ts · POST",
            "reason": "요청 처리와 API/서비스 연결 흐름을 확인할 수 있는 코드 조각",
            "excerpt": "export async function POST(request: Request) { return fetch(backendUrl); }",
            "kind": "entry",
        }
        question = {
            "id": "q1",
            "type": "구조 이해",
            "question": "src/app/api/evaluate-quiz/route.ts의 역할을 기준으로 이 프로젝트의 주요 구조를 설명해주세요.",
            "relatedFiles": ["src/app/api/evaluate-quiz/route.ts"],
            "evidenceSnippets": [route_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [route_evidence])

        self.assertNotIn("프로젝트의 주요 구조", refined[0]["question"])
        self.assertIn("POST handler", refined[0]["question"])
        self.assertEqual(refined[0]["relatedFiles"], ["src/app/api/evaluate-quiz/route.ts"])

    def test_repo_refine_prefers_question_symbol_evidence_label(self):
        class_evidence = {
            "id": "github_commit.py:0",
            "path": "apps/api/app/services/github_commit.py",
            "title": "apps/api/app/services/github_commit.py · CommitInput",
            "reason": "데이터 입력, 검증, 조회 또는 변환 흐름을 확인할 수 있는 코드 조각",
            "excerpt": "class CommitInput:\n    owner: str\n\ndef parse_github_commit_url(raw_url: str) -> CommitInput:",
            "kind": "service",
        }
        parser_evidence = {
            "id": "github_commit.py:1",
            "path": "apps/api/app/services/github_commit.py",
            "title": "apps/api/app/services/github_commit.py · parse_github_commit_url",
            "reason": "데이터 입력, 검증, 조회 또는 변환 흐름을 확인할 수 있는 코드 조각",
            "excerpt": "def parse_github_commit_url(raw_url: str) -> CommitInput:\n    parsed = urlparse(raw_url.strip())",
            "kind": "service",
        }
        question = {
            "id": "q5",
            "type": "면접형",
            "question": "면접이나 코드리뷰에서 apps/api/app/services/github_commit.py의 parse_github_commit_url 설계 의도를 어떻게 설명하겠습니까?",
            "relatedFiles": ["apps/api/app/services/github_commit.py"],
            "evidenceSnippets": [class_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [class_evidence, parser_evidence])

        self.assertEqual(refined[0]["evidenceSnippets"][0]["id"], "github_commit.py:1")
        self.assertIn("parse_github_commit_url", refined[0]["evidenceSnippets"][0]["title"])

    def test_repo_refine_rejects_docs_enabled_as_request_flow_core(self):
        docs_evidence = {
            "id": "security.py:0",
            "path": "apps/api/app/security.py",
            "title": "apps/api/app/security.py · docs_enabled",
            "reason": "선택된 함수나 클래스의 책임을 확인할 수 있는 코드 조각",
            "excerpt": "from fastapi import Header, HTTPException, Request\n\ndef docs_enabled() -> bool:\n    return os.getenv('API_ENV') != 'production'",
            "kind": "service",
        }
        entry_evidence = {
            "id": "commit.py:0",
            "path": "apps/api/app/api/commit.py",
            "title": "apps/api/app/api/commit.py · analyze_commit",
            "reason": "요청 처리와 API/서비스 연결 흐름을 확인할 수 있는 코드 조각",
            "excerpt": "def analyze_commit(payload):\n    commit_input = parse_github_commit_url(payload.url)",
            "kind": "entry",
        }
        parser_evidence = {
            "id": "github_commit.py:1",
            "path": "apps/api/app/services/github_commit.py",
            "title": "apps/api/app/services/github_commit.py · parse_github_commit_url",
            "reason": "데이터 입력, 검증, 조회 또는 변환 흐름을 확인할 수 있는 코드 조각",
            "excerpt": "def parse_github_commit_url(raw_url: str) -> CommitInput:\n    parsed = urlparse(raw_url.strip())",
            "kind": "service",
        }
        question = {
            "id": "q2",
            "type": "요청 흐름",
            "question": "apps/api/app/security.py의 docs_enabled 요청 처리 흐름이 어떻게 이어지는지 설명해주세요.",
            "relatedFiles": ["apps/api/app/security.py"],
            "evidenceSnippets": [docs_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [docs_evidence, entry_evidence, parser_evidence])

        self.assertEqual(refined[0]["relatedFiles"][:2], ["apps/api/app/api/commit.py", "apps/api/app/services/github_commit.py"])
        self.assertNotIn("docs_enabled", refined[0]["question"])

    def test_repo_structure_question_allows_multiple_layers(self):
        entry_evidence = {
            "id": "route.ts:0",
            "path": "src/app/api/users/route.ts",
            "title": "src/app/api/users/route.ts · POST",
            "reason": "요청 처리와 API/서비스 연결 흐름을 확인할 수 있는 코드 조각",
            "excerpt": "export async function POST(request: Request) { return fetchUsers(); }",
            "kind": "entry",
        }
        service_evidence = {
            "id": "user-service.ts:0",
            "path": "src/lib/user-service.ts",
            "title": "src/lib/user-service.ts · fetchUsers",
            "reason": "데이터 입력, 검증, 조회 또는 변환 흐름을 확인할 수 있는 코드 조각",
            "excerpt": "export function fetchUsers() { return repository.findMany(); }",
            "kind": "service",
        }
        question = {
            "id": "q1",
            "type": "구조 이해",
            "question": "src/app/api/users/route.ts와 src/lib/user-service.ts의 POST fetchUsers 연결을 기준으로 이 프로젝트의 주요 구조를 설명해주세요.",
            "relatedFiles": ["src/app/api/users/route.ts", "src/lib/user-service.ts"],
            "evidenceSnippets": [entry_evidence, service_evidence],
        }

        self.assertTrue(is_repo_question_evidence_aligned(question, [entry_evidence, service_evidence]))

    def test_repo_quality_guard_rewrites_duplicate_questions(self):
        evidence = [
            {
                "id": f"service-{index}.py:0",
                "path": f"apps/api/app/services/service_{index}.py",
                "title": f"apps/api/app/services/service_{index}.py run",
                "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
                "excerpt": "def run(payload):\n    return validate(payload)",
                "kind": "service",
            }
            for index in range(1, 6)
        ]
        questions = [
            {
                "id": f"q{index}",
                "type": "면접형",
                "question": "면접이나 코드리뷰에서 apps/api/app/services/service_1.py를 근거로 설계 의도와 위험 지점을 어떻게 설명하겠습니까?",
                "relatedFiles": ["apps/api/app/services/service_1.py"],
                "evidenceSnippets": [evidence[0]],
            }
            for index in range(1, 6)
        ]

        guarded = enforce_repo_question_quality(questions, questions, evidence)

        # Evidence quality takes precedence over the requested count: once a
        # scope has been consumed, the guard may drop unrecoverable duplicates.
        self.assertEqual(len({question["question"] for question in guarded}), len(guarded))
        self.assertEqual(len({question["relatedFiles"][0] for question in guarded}), len(guarded))
        self.assertLessEqual(len(guarded), 5)

    def test_repo_refine_requires_request_flow_to_include_entry_and_second_file_when_available(self):
        entry_evidence = {
            "id": "route.ts:0",
            "path": "src/app/api/users/route.ts",
            "title": "src/app/api/users/route.ts GET",
            "reason": "요청 진입점과 API 흐름을 확인할 수 있는 파일",
            "excerpt": "export async function GET() { return fetchUsers(); }",
            "kind": "entry",
        }
        service_evidence = {
            "id": "service.ts:0",
            "path": "src/lib/user-service.ts",
            "title": "src/lib/user-service.ts fetchUsers",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "export function fetchUsers() { return repository.findMany(); }",
            "kind": "service",
        }
        question = {
            "id": "q2",
            "type": "요청 흐름",
            "question": "요청 처리 흐름이 어떤 파일들을 거쳐 이어지는지 설명해주세요.",
            "relatedFiles": ["src/lib/user-service.ts"],
            "evidenceSnippets": [service_evidence],
        }
        fallback = [{**question, "relatedFiles": ["src/app/api/users/route.ts", "src/lib/user-service.ts"], "evidenceSnippets": [entry_evidence, service_evidence]}]

        refined = refine_repo_question_evidence([question], fallback, [entry_evidence, service_evidence])

        self.assertEqual(refined[0]["relatedFiles"], ["src/app/api/users/route.ts", "src/lib/user-service.ts"])
        self.assertEqual([snippet["id"] for snippet in refined[0]["evidenceSnippets"]], ["route.ts:0", "service.ts:0"])

    def test_repo_evidence_does_not_force_one_snippet_for_each_context_file(self):
        files = [
            {
                "path": f"src/lib/file-{index}.ts",
                "content": f"export function item{index}() {{\n  return fetch('/api/{index}');\n}}\n",
                "size": 80,
            }
            for index in range(15)
        ]

        context = build_repo_static_context(
            sample_repo(),
            files,
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        self.assertLessEqual(len(context["evidenceSnippets"]), 24)
        self.assertTrue(all(snippet.get("quality") == "strong" for snippet in context["evidenceSnippets"]))

    def test_repo_refine_rewrites_invalid_fallback_instead_of_keeping_wrong_evidence(self):
        config_evidence = {
            "id": "config.py:0",
            "path": "apps/api/app/config.py",
            "title": "apps/api/app/config.py configuration",
            "reason": "설정 파일",
            "excerpt": "API_PROXY_SECRET = os.getenv('API_PROXY_SECRET')",
            "kind": "config",
        }
        entry_evidence = {
            "id": "route.py:0",
            "path": "apps/api/app/api/repo.py",
            "title": "apps/api/app/api/repo.py analyze_repo",
            "reason": "요청 진입점과 API 흐름을 확인할 수 있는 파일",
            "excerpt": "def analyze_repo(payload):\n    context = build_repo_static_context(payload)",
            "kind": "entry",
        }
        service_evidence = {
            "id": "github_repo.py:0",
            "path": "apps/api/app/services/github_repo.py",
            "title": "apps/api/app/services/github_repo.py fetch_repo_files",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def fetch_repo_files(repo):\n    return fetch_tree(repo)",
            "kind": "service",
        }
        question = {
            "id": "q1",
            "type": "요청 흐름",
            "question": "apps/api/app/config.py를 포함한 요청 처리 흐름이 어떤 파일들을 거쳐 이어지는지 설명해주세요.",
            "relatedFiles": ["apps/api/app/config.py"],
            "evidenceSnippets": [config_evidence],
        }
        fallback = [{**question}]

        refined = refine_repo_question_evidence([question], fallback, [config_evidence, entry_evidence, service_evidence])

        self.assertEqual(refined[0]["relatedFiles"], ["apps/api/app/api/repo.py"])
        self.assertNotIn("config.py를 포함한 요청 처리 흐름", refined[0]["question"])

    def test_repo_refine_rejects_config_package_as_request_flow_core(self):
        config_evidence = {
            "id": "config.py:0",
            "path": "apps/api/app/config.py",
            "title": "apps/api/app/config.py configuration",
            "reason": "기술 스택, 실행 설정, 배포 구성을 확인할 수 있는 파일",
            "excerpt": "load_dotenv('.env.local', override=False)\nAPI_PROXY_SECRET = os.getenv('API_PROXY_SECRET')",
            "kind": "config",
        }
        package_evidence = {
            "id": "package.json:0",
            "path": "package.json",
            "title": "package.json configuration",
            "reason": "기술 스택, 실행 설정, 배포 구성을 확인할 수 있는 파일",
            "excerpt": "{\"scripts\":{\"dev\":\"next dev\"}}",
            "kind": "config",
        }
        entry_evidence = {
            "id": "repo.py:0",
            "path": "apps/api/app/api/repo.py",
            "title": "apps/api/app/api/repo.py analyze_repo",
            "reason": "요청 진입점과 API 흐름을 확인할 수 있는 파일",
            "excerpt": "def analyze_repo(payload):\n    return analyze_repository(payload)",
            "kind": "entry",
        }
        service_evidence = {
            "id": "repo_analysis.py:0",
            "path": "apps/api/app/services/repo_analysis.py",
            "title": "apps/api/app/services/repo_analysis.py build_repo_static_context",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def build_repo_static_context(repo, files):\n    return build_fallback_repo_analysis(context)",
            "kind": "service",
        }
        question = {
            "id": "q2",
            "type": "요청 흐름",
            "question": "apps/api/app/config.py에서 시작한 요청 흐름이 package.json과 어떻게 연결되는지 설명해주세요.",
            "relatedFiles": ["apps/api/app/config.py", "package.json"],
            "evidenceSnippets": [config_evidence, package_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [config_evidence, package_evidence, entry_evidence, service_evidence])

        self.assertEqual(refined[0]["relatedFiles"], ["apps/api/app/api/repo.py"])
        self.assertNotIn("config.py에서 시작한 요청 흐름", refined[0]["question"])

    def test_repo_refine_rejects_tally_widget_as_data_storage_flow(self):
        tally_evidence = {
            "id": "tally-feedback-button.tsx:0",
            "path": "apps/web/src/app/tally-feedback-button.tsx",
            "title": "apps/web/src/app/tally-feedback-button.tsx TallyFeedbackButton",
            "reason": "사용자 화면과 UI 흐름을 확인할 수 있는 파일",
            "excerpt": "function openTally() {\n  const formId = button.getAttribute('data-tally-open');\n  track('feedback_opened');\n}",
            "kind": "ui",
        }
        service_evidence = {
            "id": "github_repo.py:0",
            "path": "apps/api/app/services/github_repo.py",
            "title": "apps/api/app/services/github_repo.py fetch_repo_files",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def fetch_repo_files(repo):\n    data = json.loads(response.read())\n    return parse_files(data)",
            "kind": "service",
        }
        question = {
            "id": "q3",
            "type": "데이터 흐름",
            "question": "apps/web/src/app/tally-feedback-button.tsx에서 데이터 입력, 검증, 조회 또는 저장 흐름이 어떻게 드러나는지 설명해주세요.",
            "relatedFiles": ["apps/web/src/app/tally-feedback-button.tsx"],
            "evidenceSnippets": [tally_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [tally_evidence, service_evidence])

        self.assertEqual(refined[0]["relatedFiles"], ["apps/api/app/services/github_repo.py"])
        self.assertNotIn("tally-feedback-button.tsx에서 데이터 입력", refined[0]["question"])

    def test_repo_refine_rejects_config_as_request_flow_subject_even_with_schema_files(self):
        config_evidence = {
            "id": "config.py:0",
            "path": "apps/api/app/config.py",
            "title": "apps/api/app/config.py configuration",
            "reason": "기술 스택, 실행 설정, 배포 구성을 확인할 수 있는 파일",
            "excerpt": "load_dotenv('.env.local', override=False)",
            "kind": "config",
        }
        commit_schema_evidence = {
            "id": "commit.py:0",
            "path": "apps/api/app/schemas/commit.py",
            "title": "apps/api/app/schemas/commit.py AnalyzeCommitRequest",
            "reason": "데이터 모델과 저장소 접근 흐름을 확인할 수 있는 파일",
            "excerpt": "class AnalyzeCommitRequest(BaseModel):\n    url: str",
            "kind": "data",
        }
        evaluation_schema_evidence = {
            "id": "evaluation.py:0",
            "path": "apps/api/app/schemas/evaluation.py",
            "title": "apps/api/app/schemas/evaluation.py EvaluateAnswerRequest",
            "reason": "데이터 모델과 저장소 접근 흐름을 확인할 수 있는 파일",
            "excerpt": "class EvaluateAnswerRequest(BaseModel):\n    questionId: str",
            "kind": "data",
        }
        entry_evidence = {
            "id": "evaluation-api.py:0",
            "path": "apps/api/app/api/evaluation.py",
            "title": "apps/api/app/api/evaluation.py evaluate_quiz",
            "reason": "요청 진입점과 API 흐름을 확인할 수 있는 파일",
            "excerpt": "def evaluate_quiz(request: Request):\n    return evaluate_repo_quiz(payload)",
            "kind": "entry",
        }
        service_evidence = {
            "id": "evaluation-service.py:0",
            "path": "apps/api/app/services/evaluation.py",
            "title": "apps/api/app/services/evaluation.py evaluate_quiz",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def evaluate_quiz(analysis, answers):\n    return call_llm(prompt)",
            "kind": "service",
        }
        question = {
            "id": "q2",
            "type": "요청 흐름",
            "question": "apps/api/app/config.py의 요청 처리 코드가 apps/api/app/schemas/commit.py와 어떻게 연결되는지 설명해주세요.",
            "relatedFiles": ["apps/api/app/config.py", "apps/api/app/schemas/commit.py", "apps/api/app/schemas/evaluation.py"],
            "evidenceSnippets": [config_evidence, commit_schema_evidence, evaluation_schema_evidence],
        }

        refined = refine_repo_question_evidence(
            [question],
            [question],
            [config_evidence, commit_schema_evidence, evaluation_schema_evidence, entry_evidence, service_evidence],
        )

        self.assertEqual(refined[0]["relatedFiles"][:2], ["apps/api/app/api/evaluation.py", "apps/api/app/services/evaluation.py"])
        self.assertNotIn("config.py의 요청 처리 코드", refined[0]["question"])

    def test_repo_refine_rejects_config_to_ui_change_impact_without_direct_link(self):
        config_evidence = {
            "id": "config.py:0",
            "path": "apps/api/app/config.py",
            "title": "apps/api/app/config.py configuration",
            "reason": "기술 스택, 실행 설정, 배포 구성을 확인할 수 있는 파일",
            "excerpt": "BACKEND_API_URL = os.getenv('BACKEND_API_URL')",
            "kind": "config",
        }
        auth_button_evidence = {
            "id": "auth-button.tsx:0",
            "path": "apps/web/src/app/auth-button.tsx",
            "title": "apps/web/src/app/auth-button.tsx AuthButton",
            "reason": "사용자 화면과 UI 흐름을 확인할 수 있는 파일",
            "excerpt": "export function AuthButton() { return <button>Login</button>; }",
            "kind": "ui",
        }
        service_evidence = {
            "id": "evaluation.py:0",
            "path": "apps/api/app/services/evaluation.py",
            "title": "apps/api/app/services/evaluation.py evaluate_quiz",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def evaluate_quiz(analysis, answers):\n    return build_quiz_evaluation_prompt(analysis, answers)",
            "kind": "service",
        }
        entry_evidence = {
            "id": "route.ts:0",
            "path": "apps/web/src/app/api/evaluate-quiz/route.ts",
            "title": "apps/web/src/app/api/evaluate-quiz/route.ts POST",
            "reason": "요청 진입점과 API 흐름을 확인할 수 있는 파일",
            "excerpt": "export async function POST(request: Request) { return fetch(backendUrl); }",
            "kind": "entry",
        }
        question = {
            "id": "q4",
            "type": "변경 영향도",
            "question": "apps/api/app/config.py 수정이 apps/web/src/app/auth-button.tsx까지 어떤 영향을 주는지 설명해주세요.",
            "relatedFiles": ["apps/api/app/config.py", "apps/web/src/app/auth-button.tsx"],
            "evidenceSnippets": [config_evidence, auth_button_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [config_evidence, auth_button_evidence, service_evidence, entry_evidence])

        self.assertNotEqual(refined[0]["relatedFiles"], ["apps/api/app/config.py", "apps/web/src/app/auth-button.tsx"])
        self.assertNotIn("config.py 수정이", refined[0]["question"])

    def test_repo_refine_rejects_schema_to_unrelated_auth_ui_impact(self):
        schema_evidence = {
            "id": "commit.py:0",
            "path": "apps/api/app/schemas/commit.py",
            "title": "apps/api/app/schemas/commit.py CommitQuestion",
            "reason": "데이터 모델과 저장소 접근 흐름을 확인할 수 있는 파일",
            "excerpt": "class CommitQuestion(BaseModel):\n    question: str",
            "kind": "data",
        }
        auth_button_evidence = {
            "id": "auth-button.tsx:0",
            "path": "apps/web/src/app/auth-button.tsx",
            "title": "apps/web/src/app/auth-button.tsx AuthButton",
            "reason": "사용자 화면과 UI 흐름을 확인할 수 있는 파일",
            "excerpt": "export function AuthButton() { return <button>Login</button>; }",
            "kind": "ui",
        }
        entry_evidence = {
            "id": "analyze-commit-route.ts:0",
            "path": "apps/web/src/app/api/analyze-commit/route.ts",
            "title": "apps/web/src/app/api/analyze-commit/route.ts POST",
            "reason": "요청 진입점과 API 흐름을 확인할 수 있는 파일",
            "excerpt": "export async function POST(request: Request) { return fetch(backendUrl); }",
            "kind": "entry",
        }
        service_evidence = {
            "id": "github_commit.py:0",
            "path": "apps/api/app/services/github_commit.py",
            "title": "apps/api/app/services/github_commit.py fetch_commit_changes",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def fetch_commit_changes(commit_input):\n    return request_github_commit(commit_input)",
            "kind": "service",
        }
        question = {
            "id": "q4",
            "type": "변경 영향도",
            "question": "apps/api/app/schemas/commit.py 수정이 apps/web/src/app/auth-button.tsx까지 어떤 영향이 이어지는지 설명해주세요.",
            "relatedFiles": ["apps/api/app/schemas/commit.py", "apps/web/src/app/auth-button.tsx"],
            "evidenceSnippets": [schema_evidence, auth_button_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [schema_evidence, auth_button_evidence, entry_evidence, service_evidence])

        self.assertNotEqual(refined[0]["relatedFiles"], ["apps/api/app/schemas/commit.py", "apps/web/src/app/auth-button.tsx"])
        self.assertNotIn("schemas/commit.py 수정이", refined[0]["question"])

    def test_repo_refine_rejects_service_to_unrelated_ui_impact_without_entry_link(self):
        service_evidence = {
            "id": "commit_analysis.py:0",
            "path": "apps/api/app/services/commit_analysis.py",
            "title": "apps/api/app/services/commit_analysis.py build_commit_static_context",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def build_commit_static_context(commit_changes):\n    return build_commit_evidence_snippets(commit_changes)",
            "kind": "service",
        }
        auth_button_evidence = {
            "id": "auth-button.tsx:0",
            "path": "apps/web/src/app/auth-button.tsx",
            "title": "apps/web/src/app/auth-button.tsx AuthButton",
            "reason": "사용자 화면과 UI 흐름을 확인할 수 있는 파일",
            "excerpt": "export function AuthButton() { return <button>Login</button>; }",
            "kind": "ui",
        }
        entry_evidence = {
            "id": "analyze-commit-route.ts:0",
            "path": "apps/web/src/app/api/analyze-commit/route.ts",
            "title": "apps/web/src/app/api/analyze-commit/route.ts POST",
            "reason": "요청 진입점과 API 흐름을 확인할 수 있는 파일",
            "excerpt": "export async function POST(request: Request) { return fetch(backendUrl); }",
            "kind": "entry",
        }
        question = {
            "id": "q4",
            "type": "변경 영향도",
            "question": "apps/api/app/services/commit_analysis.py 수정이 apps/web/src/app/auth-button.tsx까지 어떤 영향이 이어지는지 설명해주세요.",
            "relatedFiles": ["apps/api/app/services/commit_analysis.py", "apps/web/src/app/auth-button.tsx"],
            "evidenceSnippets": [service_evidence, auth_button_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [service_evidence, auth_button_evidence, entry_evidence])

        self.assertNotEqual(refined[0]["relatedFiles"], ["apps/api/app/services/commit_analysis.py", "apps/web/src/app/auth-button.tsx"])
        self.assertNotIn("auth-button.tsx까지", refined[0]["question"])

    def test_repo_classifies_auth_and_tally_components_as_ui(self):
        self.assertEqual(file_layer("apps/web/src/app/auth-button.tsx"), "ui")
        self.assertEqual(file_layer("apps/web/src/app/tally-feedback-button.tsx"), "ui")
        self.assertEqual(infer_file_reason("apps/web/src/app/tally-feedback-button.tsx"), "사용자 화면과 UI 흐름을 확인할 수 있는 파일")

    def test_repo_does_not_classify_all_apps_api_files_as_entrypoints(self):
        self.assertEqual(file_layer("apps/api/app/services/commit_analysis.py"), "service")
        self.assertEqual(file_layer("apps/api/app/services/evaluation.py"), "service")
        self.assertEqual(file_layer("apps/api/app/api/repo.py"), "entry")
        self.assertEqual(file_layer("apps/web/src/app/api/analyze-commit/route.ts"), "entry")

    def test_repo_refine_deprioritizes_maintenance_files_for_interview(self):
        fixer_evidence = {
            "id": "SchemaConstraintFixer.java:0",
            "path": "src/main/java/com/demo/config/SchemaConstraintFixer.java",
            "title": "src/main/java/com/demo/config/SchemaConstraintFixer.java SchemaConstraintFixer",
            "reason": "프로젝트 구조 이해에 참고할 수 있는 파일",
            "excerpt": "public class SchemaConstraintFixer { void fixConstraints() {} }",
            "kind": "service",
        }
        service_evidence = {
            "id": "RecommendationService.java:0",
            "path": "src/main/java/com/demo/service/RecommendationService.java",
            "title": "src/main/java/com/demo/service/RecommendationService.java recommend",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "public List<Item> recommend(User user) { return repository.findByUser(user); }",
            "kind": "service",
        }
        question = {
            "id": "q5",
            "type": "면접형",
            "question": "면접이나 코드리뷰에서 src/main/java/com/demo/config/SchemaConstraintFixer.java의 설계 의도와 위험 지점을 어떻게 설명하겠습니까?",
            "relatedFiles": ["src/main/java/com/demo/config/SchemaConstraintFixer.java"],
            "evidenceSnippets": [fixer_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [fixer_evidence, service_evidence])

        self.assertEqual(refined[0]["relatedFiles"], ["src/main/java/com/demo/service/RecommendationService.java"])

    def test_repo_refine_prefers_strong_data_flow_over_constant_only_vector_dimension(self):
        constant_evidence = {
            "id": "schemas.py:0",
            "path": "app/schemas.py",
            "title": "app/schemas.py EMBEDDING_DIMENSION",
            "reason": "데이터 모델과 저장소 접근 흐름을 확인할 수 있는 파일",
            "excerpt": "EMBEDDING_DIMENSION = 1536\nVECTOR_TYPE = 'pgvector'",
            "kind": "data",
        }
        service_evidence = {
            "id": "recommendation_service.py:0",
            "path": "app/services/recommendation_service.py",
            "title": "app/services/recommendation_service.py search",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def search(query):\n    embedding = parse_query(query)\n    return repository.find_similar(embedding)",
            "kind": "service",
        }
        question = {
            "id": "q3",
            "type": "데이터 흐름",
            "question": "app/schemas.py의 pgvector 차원 값이 데이터 흐름에 어떤 영향을 주는지 설명해주세요.",
            "relatedFiles": ["app/schemas.py"],
            "evidenceSnippets": [constant_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [constant_evidence, service_evidence])

        self.assertEqual(refined[0]["relatedFiles"], ["app/services/recommendation_service.py"])

    def test_repo_refine_rejects_config_tally_pair_for_interview_question(self):
        config_evidence = {
            "id": "config.py:0",
            "path": "apps/api/app/config.py",
            "title": "apps/api/app/config.py configuration",
            "reason": "기술 스택, 실행 설정, 배포 구성을 확인할 수 있는 파일",
            "excerpt": "API_PROXY_SECRET = os.getenv('API_PROXY_SECRET')",
            "kind": "config",
        }
        tally_evidence = {
            "id": "tally-feedback-button.tsx:0",
            "path": "apps/web/src/app/tally-feedback-button.tsx",
            "title": "apps/web/src/app/tally-feedback-button.tsx TallyFeedbackButton",
            "reason": "사용자 화면과 UI 흐름을 확인할 수 있는 파일",
            "excerpt": "track('feedback_opened')",
            "kind": "ui",
        }
        service_evidence = {
            "id": "llm.py:0",
            "path": "apps/api/app/services/llm.py",
            "title": "apps/api/app/services/llm.py call_configured_provider",
            "reason": "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일",
            "excerpt": "def call_configured_provider(prompt, max_output_tokens):\n    return call_groq(prompt)",
            "kind": "service",
        }
        question = {
            "id": "q5",
            "type": "면접형",
            "question": "면접이나 코드리뷰에서 apps/api/app/config.py를 근거로 설계 의도와 위험 지점을 어떻게 설명하겠습니까?",
            "relatedFiles": ["apps/api/app/config.py", "apps/web/src/app/tally-feedback-button.tsx"],
            "evidenceSnippets": [config_evidence, tally_evidence],
        }

        refined = refine_repo_question_evidence([question], [question], [config_evidence, tally_evidence, service_evidence])

        self.assertNotIn("apps/web/src/app/tally-feedback-button.tsx", refined[0]["relatedFiles"])


if __name__ == "__main__":
    unittest.main()
