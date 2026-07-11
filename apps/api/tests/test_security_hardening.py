import os
import unittest
from unittest.mock import patch

from app.observability import scrub_sentry_event
from app.config import deployment_commit_sha
from app.api.evaluation import validate_analysis_payload
from app.security import validate_runtime_config
from app.services.evaluation import normalize_quiz_evaluation
from app.services.commit_analysis import build_commit_static_context
from app.services.github_repo import should_include_path
from app.services.redaction import is_sensitive_file_path, redact_secrets
from app.services.repo_analysis import build_repo_static_context


class RedactionTest(unittest.TestCase):
    @patch.dict(os.environ, {"COMMIT_SHA": "abc123", "RENDER_GIT_COMMIT": "older"}, clear=False)
    def test_deployment_commit_sha_uses_explicit_override(self):
        self.assertEqual(deployment_commit_sha(), "abc123")

    def test_redacts_secret_like_values_without_removing_normal_code(self):
        content = "\n".join(
            [
                "const visible = 'ok';",
                "GEMINI_API_KEY=abc123",
                "const GEMINI_API_KEY = 'sk-live-secret';",
                'export const token = "abc123";',
                'process.env.API_KEY = "process-secret";',
                '{"clientSecret": "json-secret",',
                "password: yaml-secret",
                "const openAiKey = 'sk-1234567890abcdefghijklmnop';",
                "Authorization: Bearer super-secret-token",
                "EVALUATION_OUTPUT_TOKENS = int(os.getenv('EVALUATION_OUTPUT_TOKENS', '1200'))",
                "-----BEGIN PRIVATE KEY-----",
                "abc",
                "-----END PRIVATE KEY-----",
            ]
        )

        redacted = redact_secrets(content)

        self.assertIn("const visible = 'ok';", redacted)
        self.assertIn("int(os.getenv('EVALUATION_OUTPUT_TOKENS', '1200'))", redacted)
        self.assertNotIn("abc123", redacted)
        self.assertNotIn("sk-live-secret", redacted)
        self.assertNotIn("process-secret", redacted)
        self.assertNotIn("json-secret", redacted)
        self.assertNotIn("yaml-secret", redacted)
        self.assertNotIn("sk-1234567890abcdefghijklmnop", redacted)
        self.assertNotIn("super-secret-token", redacted)
        self.assertNotIn("BEGIN PRIVATE KEY", redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_sensitive_files_are_excluded_but_env_example_is_allowed_and_redacted(self):
        self.assertTrue(is_sensitive_file_path("apps/web/.env.local"))
        self.assertTrue(is_sensitive_file_path(".npmrc"))
        self.assertTrue(is_sensitive_file_path("deploy/service-account-prod.json"))
        self.assertTrue(is_sensitive_file_path("certs/private.pem"))
        self.assertTrue(is_sensitive_file_path(".aws/credentials"))
        self.assertFalse(is_sensitive_file_path(".env.example"))
        self.assertFalse(should_include_path(".env.local"))
        self.assertFalse(should_include_path("deploy/service-account-prod.json"))
        self.assertTrue(should_include_path(".env.example"))

    def test_repo_context_redacts_evidence_and_summary_excerpts(self):
        context = build_repo_static_context(
            {"owner": "acme", "repo": "demo", "url": "https://github.com/acme/demo"},
            [{"path": ".env.example", "content": "GROQ_API_KEY=secret-value\nexport function ok() {}", "size": 60}],
            "balanced",
            "standard",
            ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
            [],
        )

        text = "\n".join([context["contextFiles"][0]["excerpt"], context["evidenceSnippets"][0]["excerpt"]])
        self.assertNotIn("secret-value", text)
        self.assertIn("[REDACTED]", text)

    def test_commit_context_redacts_patch_evidence(self):
        context = build_commit_static_context(
            {
                "commit": {"owner": "acme", "repo": "demo", "sha": "abc", "shortSha": "abc"},
                "files": [
                    {
                        "path": "src/config.ts",
                        "status": "modified",
                        "additions": 1,
                        "deletions": 0,
                        "changes": 1,
                        "patch": "@@ -1 +1 @@\n+API_SECRET=commit-secret",
                    }
                ],
                "totalAdditions": 1,
                "totalDeletions": 0,
            }
        )

        text = "\n".join([context["contextFiles"][0]["excerpt"], context["evidenceSnippets"][0]["excerpt"]])
        self.assertNotIn("commit-secret", text)
        self.assertIn("[REDACTED]", text)


class ObservabilityScrubTest(unittest.TestCase):
    def test_scrubs_sensitive_string_values_in_nested_event_data(self):
        event = {
            "request": {
                "headers": {"x-debug": "Authorization: Bearer token-value"},
                "data": {"answer": "user answer"},
                "cookies": {"session": "cookie"},
            },
            "extra": {"message": "GEMINI_API_KEY=secret-value"},
            "breadcrumbs": [{"data": {"payload": 'const API_TOKEN = "code-secret"\npassword=secret-password'}}],
        }

        scrubbed = scrub_sentry_event(event, {})
        rendered = str(scrubbed)

        self.assertNotIn("token-value", rendered)
        self.assertNotIn("secret-value", rendered)
        self.assertNotIn("code-secret", rendered)
        self.assertNotIn("secret-password", rendered)
        self.assertNotIn("user answer", rendered)
        self.assertNotIn("cookie", rendered)


class RuntimeConfigTest(unittest.TestCase):
    def test_production_config_fails_fast_when_auth_is_disabled(self):
        env = {
            **os.environ,
            "API_ENV": "production",
            "API_DOCS_ENABLED": "false",
            "API_AUTH_REQUIRED": "false",
            "API_PROXY_SECRET": "secret",
            "REDIS_URL": "redis://localhost:6379/0",
        }
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "API_AUTH_REQUIRED"):
                validate_runtime_config()

    def test_production_config_accepts_required_security_settings(self):
        env = {
            **os.environ,
            "API_ENV": "production",
            "API_DOCS_ENABLED": "false",
            "API_AUTH_REQUIRED": "true",
            "API_PROXY_SECRET": "secret",
            "REDIS_URL": "redis://localhost:6379/0",
        }
        with patch.dict(os.environ, env, clear=True):
            validate_runtime_config()


class EvaluationPayloadLimitTest(unittest.TestCase):
    def test_rejects_oversized_evaluation_analysis_payload(self):
        analysis = {
            "questions": [{"id": "q1", "evidenceSnippets": []}],
            "contextFiles": [{"path": "src/app.ts", "reason": "test", "excerpt": "x" * 20}],
        }

        with patch.dict(os.environ, {"MAX_EVALUATION_EXCERPT_CHARS": "10"}):
            with self.assertRaisesRegex(Exception, "평가 코드 근거 내용이 너무 깁니다"):
                validate_analysis_payload(analysis)

    def test_accepts_normal_evaluation_analysis_payload(self):
        analysis = {
            "questions": [{"id": "q1", "evidenceSnippets": [{"excerpt": "function ok() {}", "path": "src/app.ts"}]}],
            "contextFiles": [{"path": "src/app.ts", "reason": "test", "excerpt": "function ok() {}"}],
        }

        validate_analysis_payload(analysis)


class EvaluationScoreNormalizationTest(unittest.TestCase):
    def test_normalizes_low_scale_question_scores_and_recomputes_average(self):
        questions = [{"id": f"q{index}"} for index in range(1, 6)]
        fallback = {
            "summary": "fallback",
            "strengths": ["fallback"],
            "weaknesses": ["fallback"],
            "reviewFiles": [],
            "questionEvaluations": [
                {
                    "questionId": question["id"],
                    "score": 42,
                    "scoreReason": "fallback",
                    "understood": ["fallback"],
                    "missing": ["fallback"],
                    "incorrect": [],
                    "relatedFiles": [],
                    "reviewCode": [],
                    "betterAnswer": "fallback",
                    "interviewAnswerDirection": "fallback",
                    "followUpQuestion": "fallback",
                }
                for question in questions
            ],
        }
        parsed = {
            "averageScore": 100,
            "summary": "parsed",
            "strengths": ["parsed"],
            "weaknesses": ["parsed"],
            "reviewFiles": [],
            "questionEvaluations": [
                {"questionId": "q1", "score": 2, "scoreReason": "ok"},
                {"questionId": "q2", "score": 1, "scoreReason": "partial"},
                {"questionId": "q3", "score": 0, "scoreReason": "miss"},
                {"questionId": "q4", "score": 0, "scoreReason": "miss"},
                {"questionId": "q5", "score": 0, "scoreReason": "miss"},
            ],
        }

        normalized = normalize_quiz_evaluation(parsed, fallback, questions)

        self.assertEqual([item["score"] for item in normalized["questionEvaluations"]], [100, 50, 0, 0, 0])
        self.assertEqual(normalized["averageScore"], 30)


if __name__ == "__main__":
    unittest.main()
