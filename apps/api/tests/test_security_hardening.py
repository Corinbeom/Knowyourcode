import os
import unittest
from unittest.mock import patch

from app.observability import scrub_sentry_event
from app.security import validate_runtime_config
from app.services.commit_analysis import build_commit_static_context
from app.services.github_repo import should_include_path
from app.services.redaction import is_sensitive_file_path, redact_secrets
from app.services.repo_analysis import build_repo_static_context


class RedactionTest(unittest.TestCase):
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
                "-----BEGIN PRIVATE KEY-----",
                "abc",
                "-----END PRIVATE KEY-----",
            ]
        )

        redacted = redact_secrets(content)

        self.assertIn("const visible = 'ok';", redacted)
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


if __name__ == "__main__":
    unittest.main()
