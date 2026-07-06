import unittest
from unittest.mock import patch

from app.services.commit_analysis import (
    build_commit_evidence_snippets,
    build_commit_static_context,
    build_fallback_commit_analysis,
    split_patch_hunks,
)
from app.services.llm import is_question_evidence_aligned, normalize_commit_questions, refine_commit_question_evidence


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

    def test_patchless_file_creates_fallback_evidence(self):
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

        self.assertEqual(len(snippets), 1)
        self.assertEqual(snippets[0]["path"], "public/logo.png")
        self.assertIn("patch를 제공하지 않는 파일", snippets[0]["excerpt"])

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

    def test_fallback_commit_questions_all_have_evidence(self):
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

        self.assertEqual(len(analysis["questions"]), 4)
        self.assertTrue(all(question["evidenceSnippets"] for question in analysis["questions"]))

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
