import unittest
from unittest.mock import patch

from app.services.commit_analysis import (
    build_commit_evidence_snippets,
    build_commit_static_context,
    build_fallback_commit_analysis,
    split_patch_hunks,
)
from app.services.llm import (
    enforce_commit_question_quality,
    is_question_evidence_aligned,
    normalize_commit_questions,
    refine_commit_question_evidence,
)


def sample_commit_changes(files):
    return {
        "commit": {
            "owner": "acme",
            "repo": "demo",
            "sha": "abc123",
            "shortSha": "abc123",
            "url": "https://github.com/acme/demo/commit/abc123",
            "message": "change service",
            "author": "tester",
            "committedAt": "2026-01-01T00:00:00Z",
        },
        "files": files,
        "totalAdditions": sum(file.get("additions", 0) for file in files),
        "totalDeletions": sum(file.get("deletions", 0) for file in files),
    }


class CommitEvidenceTest(unittest.TestCase):
    def test_split_patch_hunks_separates_multiple_hunks(self):
        file = {
            "path": "app/service.py",
            "patch": "@@ -1,3 +1,4 @@\n def a():\n+    return 1\n@@ -20,3 +21,4 @@\n def b():\n+    return 2",
        }

        hunks = split_patch_hunks(file)

        self.assertEqual(len(hunks), 2)
        self.assertIn("@@ -1,3 +1,4 @@", hunks[0]["header"])
        self.assertIn("return 2", hunks[1]["excerpt"])

    def test_long_patch_hunk_is_truncated_at_line_boundary_with_marker(self):
        long_line = "+    result = process_commit_context()"
        file = {
            "path": "app/service.py",
            "patch": "@@ -1,80 +1,80 @@\n" + "\n".join([long_line] * 80),
        }

        hunk = split_patch_hunks(file)[0]

        self.assertTrue(hunk["excerpt"].endswith("... 이후 변경 내용 생략 ..."))
        self.assertNotIn("process_commit_con\n", hunk["excerpt"])
        self.assertTrue(all(line == long_line or line.startswith("@@") or "변경 내용 생략" in line for line in hunk["excerpt"].splitlines()))

    def test_commit_evidence_uses_function_scope_and_starts_at_declaration(self):
        snippets = build_commit_evidence_snippets([
            {
                "path": "src/lib/ai.ts",
                "status": "modified",
                "additions": 2,
                "deletions": 0,
                "changes": 2,
                "patch": (
                    "@@ -10,4 +10,5 @@ function normalizeCommitChangedFiles(input) {\n"
                    "   const previousContext = true;\n"
                    "+  if (!input) return [];\n"
                    "   return input;"
                ),
            }
        ])

        self.assertEqual(snippets[0]["title"], "src/lib/ai.ts · normalizeCommitChangedFiles")
        self.assertTrue(snippets[0]["excerpt"].startswith("function normalizeCommitChangedFiles"))
        self.assertNotIn("@@ -10", snippets[0]["excerpt"])

    def test_changed_function_declaration_beats_previous_hunk_context(self):
        snippets = build_commit_evidence_snippets([
            {
                "path": "src/lib/ai.ts",
                "status": "modified",
                "additions": 3,
                "deletions": 0,
                "changes": 3,
                "patch": (
                    "@@ -10,4 +10,8 @@ function normalizeKeyFiles(input) {\n"
                    "   return input;\n"
                    "+function normalizeCommitChangedFiles(files) {\n"
                    "+  if (!files) return [];\n"
                    "+}"
                ),
            }
        ])

        self.assertEqual(snippets[0]["title"], "src/lib/ai.ts · normalizeCommitChangedFiles")
        self.assertTrue(snippets[0]["excerpt"].startswith("+function normalizeCommitChangedFiles"))
        self.assertNotIn("normalizeKeyFiles", snippets[0]["excerpt"])

    def test_normal_branch_test_question_is_rewritten_without_exception_scope(self):
        evidence = {
            "id": "normalize",
            "path": "src/lib/ai.ts",
            "title": "src/lib/ai.ts · normalizeCommitChangedFiles",
            "reason": "정상 분기 변경",
            "excerpt": "function normalizeCommitChangedFiles(input) { if (!input) return []; return input; }",
            "kind": "modified",
            "quality": "strong",
        }
        question = {
            "id": "q3",
            "type": "테스트/리스크",
            "question": "normalizeCommitChangedFiles 변경 후 어떤 테스트나 예외 케이스를 확인해야 하나요?",
            "relatedFiles": ["src/lib/ai.ts"],
            "evidenceSnippets": [evidence],
        }

        guarded = enforce_commit_question_quality([question], [question], [evidence])

        self.assertNotIn("예외 케이스", guarded[0]["question"])
        self.assertIn("정상 분기와 반환 동작", guarded[0]["question"])
        self.assertIn("normalizeCommitChangedFiles", guarded[0]["question"])

    def test_patchless_file_does_not_create_question_evidence(self):
        snippets = build_commit_evidence_snippets(
            [
                {
                    "path": "public/logo.png",
                    "status": "modified",
                    "additions": 0,
                    "deletions": 0,
                    "changes": 1,
                    "patch": "",
                }
            ]
        )

        self.assertEqual(snippets, [])

    def test_invalid_llm_snippet_id_falls_back_to_path_evidence(self):
        evidence = build_commit_evidence_snippets(
            [
                {
                    "path": "app/service.py",
                    "status": "modified",
                    "additions": 2,
                    "deletions": 1,
                    "changes": 3,
                    "patch": "@@ -1,2 +1,3 @@\n def run():\n+    return True",
                }
            ]
        )
        fallback = [
            {"id": f"q{index}", "type": "변경 의도", "question": "fallback", "relatedFiles": ["app/service.py"], "evidenceSnippets": [evidence[0]]}
            for index in range(1, 5)
        ]
        raw_questions = [
            {"id": f"q{index}", "type": question_type, "question": "왜 바뀌었나요?", "relatedFiles": ["app/service.py"], "evidenceSnippetIds": ["missing-id"]}
            for index, question_type in enumerate(["변경 의도", "변경 영향도", "테스트/리스크", "리뷰형"], start=1)
        ]

        questions = normalize_commit_questions(raw_questions, fallback, evidence)

        self.assertEqual(len(questions), 4)
        self.assertEqual(questions[0]["evidenceSnippets"][0]["id"], evidence[0]["id"])

    def test_fallback_commit_requires_minimum_strong_evidence(self):
        context = build_commit_static_context(
            sample_commit_changes(
                [
                    {
                        "path": "app/service.py",
                        "status": "modified",
                        "additions": 2,
                        "deletions": 1,
                        "changes": 3,
                        "patch": "@@ -1,2 +1,3 @@\n def run():\n+    return True",
                    }
                ]
            )
        )

        analysis = build_fallback_commit_analysis(context)

        self.assertEqual(analysis["questions"], [])
        self.assertIn("분석 가능한 실행 흐름이 부족", analysis["ai"]["reason"])

    def test_refine_reselects_evidence_when_question_path_mismatches(self):
        route_evidence = {
            "id": "apps-web-src-app-api-evaluate-commit-quiz-route.ts:0",
            "path": "apps/web/src/app/api/evaluate-commit-quiz/route.ts",
            "title": "apps/web/src/app/api/evaluate-commit-quiz/route.ts @@ route @@",
            "reason": "커밋 퀴즈 평가 API 변경입니다.",
            "excerpt": "const rateLimit = consumeRateLimit(request, { namespace: \"evaluate-commit\" });",
            "kind": "modified",
        }
        ai_evidence = {
            "id": "apps-web-src-lib-ai.ts:0",
            "path": "apps/web/src/lib/ai.ts",
            "title": "apps/web/src/lib/ai.ts @@ evaluateCommitQuiz @@",
            "reason": "평가 프롬프트 변경입니다.",
            "excerpt": "export async function evaluateCommitQuiz() {}",
            "kind": "modified",
        }
        question = {
            "id": "q1",
            "type": "리뷰형",
            "question": "apps/web/src/app/api/evaluate-commit-quiz/route.ts에서 rate limit 적용 방식은 어떤가요?",
            "relatedFiles": ["apps/web/src/app/api/evaluate-commit-quiz/route.ts"],
            "evidenceSnippets": [ai_evidence],
        }
        fallback = [{**question, "evidenceSnippets": [route_evidence]}]

        refined = refine_commit_question_evidence([question], fallback, [ai_evidence, route_evidence])

        self.assertTrue(is_question_evidence_aligned(refined[0]))
        self.assertEqual(refined[0]["evidenceSnippets"][0]["id"], route_evidence["id"])

    def test_quality_guard_rewrites_question_when_explicit_path_mismatches_evidence(self):
        route_evidence = {
            "id": "route.ts:0",
            "path": "src/app/api/evaluate-commit-quiz/route.ts",
            "title": "src/app/api/evaluate-commit-quiz/route.ts POST",
            "reason": "커밋 평가 API 변경입니다.",
            "excerpt": "export async function POST(request: Request) { return evaluateCommitQuiz(input); }",
            "kind": "modified",
        }
        ai_evidence = {
            "id": "ai.ts:0",
            "path": "src/lib/ai.ts",
            "title": "src/lib/ai.ts evaluateCommitQuiz",
            "reason": "평가 프롬프트 변경입니다.",
            "excerpt": "export async function evaluateCommitQuiz(input) { return callModel(input); }",
            "kind": "modified",
        }
        question = {
            "id": "q4",
            "type": "리뷰형",
            "question": "코드 리뷰에서 src/app/api/evaluate-commit-quiz/route.ts 변경의 책임 분리, 예외 처리, 회귀 위험 중 무엇을 질문받을 수 있나요?",
            "relatedFiles": ["src/app/api/evaluate-commit-quiz/route.ts"],
            "evidenceSnippets": [ai_evidence],
        }

        guarded = enforce_commit_question_quality([question], [question], [ai_evidence, route_evidence])

        self.assertNotIn("route.ts", guarded[0]["question"])
        self.assertEqual(guarded[0]["relatedFiles"], ["src/lib/ai.ts"])
        self.assertEqual(guarded[0]["evidenceSnippets"][0]["id"], "ai.ts:0")

    def test_quality_guard_rewrites_duplicate_commit_questions(self):
        evidence = [
            {
                "id": f"file-{index}.ts:0",
                "path": f"src/file-{index}.ts",
                "title": f"src/file-{index}.ts change",
                "reason": "변경 파일입니다.",
                "excerpt": "export function run() { return true; }",
                "kind": "modified",
            }
            for index in range(1, 5)
        ]
        questions = [
            {
                "id": f"q{index}",
                "type": "리뷰형",
                "question": "코드 리뷰에서 src/file-1.ts 변경의 책임 분리, 예외 처리, 회귀 위험 중 무엇을 질문받을 수 있나요?",
                "relatedFiles": ["src/file-1.ts"],
                "evidenceSnippets": [evidence[0]],
            }
            for index in range(1, 5)
        ]

        guarded = enforce_commit_question_quality(questions, questions, evidence)

        self.assertEqual(len({question["question"] for question in guarded}), 4)
        self.assertEqual(len({question["relatedFiles"][0] for question in guarded}), 4)

    @patch.dict("os.environ", {"GROQ_API_KEY": "test-key"})
    @patch("app.services.llm.call_groq")
    def test_refine_uses_groq_judge_for_ambiguous_question(self, mock_call_groq):
        selected_evidence = {
            "id": "service.ts:0",
            "path": "src/service.ts",
            "title": "src/service.ts @@ run @@",
            "reason": "서비스 로직 변경입니다.",
            "excerpt": "export function run() { return true; }",
            "kind": "modified",
        }
        wrong_evidence = {
            "id": "README.md:0",
            "path": "README.md",
            "title": "README.md patch unavailable",
            "reason": "문서 변경입니다.",
            "excerpt": "docs",
            "kind": "modified",
        }
        question = {
            "id": "q1",
            "type": "리뷰형",
            "question": "책임 분리 관점에서 구현 선택이 적절한가요?",
            "relatedFiles": ["README.md"],
            "evidenceSnippets": [wrong_evidence],
        }
        fallback = [{**question, "evidenceSnippets": [wrong_evidence]}]
        mock_call_groq.return_value = {
            "text": '{"answerable": true, "bestEvidenceIds": ["service.ts:0"], "reason": "서비스 구현 근거가 더 적절합니다."}',
            "usage": {"provider": "groq", "used": True},
        }

        refined = refine_commit_question_evidence([question], fallback, [wrong_evidence, selected_evidence])

        self.assertEqual(refined[0]["evidenceSnippets"][0]["id"], selected_evidence["id"])
        mock_call_groq.assert_called_once()


if __name__ == "__main__":
    unittest.main()
