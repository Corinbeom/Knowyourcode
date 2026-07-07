import unittest

from app.services.repo_analysis import build_fallback_repo_analysis, build_repo_static_context, file_layer, infer_file_reason
from app.services.llm import refine_repo_question_evidence


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

        self.assertEqual(len(analysis["questions"]), 5)
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

    def test_repo_evidence_keeps_one_snippet_for_each_context_file(self):
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

        evidence_paths = {snippet["path"] for snippet in context["evidenceSnippets"]}

        self.assertTrue(all(file["path"] in evidence_paths for file in files))

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

        self.assertEqual(refined[0]["relatedFiles"], ["apps/api/app/api/repo.py", "apps/api/app/services/github_repo.py"])
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

        self.assertEqual(refined[0]["relatedFiles"][:2], ["apps/api/app/api/repo.py", "apps/api/app/services/repo_analysis.py"])
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
