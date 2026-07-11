import unittest
from unittest.mock import patch

from app.schemas.evaluation import EvaluateQuizResponse
from app.schemas.repo import CodeEvidence
from app.services.evaluation import (
    build_fallback_quiz_evaluation,
    classify_answer,
    invalid_question_reason,
    normalize_quiz_evaluation,
)
from app.services.llm import generate_commit_analysis, generate_repo_analysis, has_unlinked_constant_subject, question_capability_gap, with_korean_particle
from app.services.repo_analysis import classify_repo_evidence


def strong_question(question_id: str = "q1") -> dict:
    return {
        "id": question_id,
        "type": "요청 흐름",
        "question": "src/api/route.ts의 POST handler가 요청을 어떻게 처리하나요?",
        "relatedFiles": ["src/api/route.ts"],
        "evidenceSnippets": [
            {
                "id": "route-post",
                "path": "src/api/route.ts",
                "title": "src/api/route.ts · POST",
                "reason": "POST 요청 처리 흐름",
                "excerpt": "export async function POST(request) { return handle(await request.json()); }",
                "kind": "entry",
                "quality": "strong",
            }
        ],
    }


def constant_question() -> dict:
    return {
        "id": "q2",
        "type": "변경 영향도",
        "question": "MAX_COMMIT_FILES가 실제 커밋 분석 과정에 어떤 영향을 주나요?",
        "relatedFiles": ["src/commit-analysis.ts"],
        "evidenceSnippets": [
            {
                "id": "max-commit-files",
                "path": "src/commit-analysis.ts",
                "title": "src/commit-analysis.ts · MAX_COMMIT_FILES",
                "reason": "분석 파일 수 제한 상수",
                "excerpt": "export const MAX_COMMIT_FILES = 12;",
                "kind": "service",
                "quality": "conditional",
            }
        ],
    }


class EvaluationQualityTest(unittest.TestCase):
    def test_evidence_challenge_phrase_is_classified(self):
        answer = "제공된 근거만으로 실제 분석 과정에 미치는 영향은 확인할 수 없습니다."

        self.assertEqual(classify_answer(answer), "question_challenge")

    def test_missing_exception_code_challenge_excludes_review_question(self):
        question = {
            "id": "q4",
            "type": "리뷰형",
            "question": "코드 리뷰에서 service.py 변경의 예외 처리와 회귀 위험을 어떻게 설명하나요?",
            "relatedFiles": ["service.py"],
            "evidenceSnippets": [{
                "id": "service-run",
                "path": "service.py",
                "title": "service.py · run",
                "reason": "변경된 실행 흐름",
                "excerpt": "def run(value):\n    return transform(value)",
                "kind": "service",
                "quality": "strong",
            }],
        }
        answer = "예외 처리나 회귀 위험을 확인할 코드가 제공된 정보에 없습니다."

        self.assertEqual(classify_answer(answer), "question_challenge")
        self.assertIn("예외", invalid_question_reason(question))
        result = build_fallback_quiz_evaluation({"questions": [question], "contextFiles": []}, [{"questionId": "q4", "answer": answer}], True)
        self.assertEqual(result["questionEvaluations"][0]["evaluationStatus"], "invalid_question")
        self.assertEqual(result["strengths"], [])

    def test_commit_regression_scope_challenge_is_invalid_and_excluded_from_aggregates(self):
        review_question = {
            "id": "q4",
            "type": "리뷰형",
            "question": "코드 리뷰에서 lib/ai.ts 변경의 구현 의도와 코드에서 확인되는 회귀 위험을 어떻게 설명하겠습니까?",
            "relatedFiles": ["lib/ai.ts"],
            "evidenceSnippets": [{
                "id": "ai:generateCommitAnalysis",
                "path": "lib/ai.ts",
                "title": "lib/ai.ts · generateCommitAnalysis",
                "reason": "프롬프트 구성 변경",
                "excerpt": "export async function generateCommitAnalysis(context) {\n  const prompt = `Commit: ${context.commit.message}`;\n  return callConfiguredProvider(prompt);\n}",
                "kind": "service",
                "quality": "strong",
            }],
        }
        challenge = (
            "질문에서 요구하는 회귀 위험을 확인할 코드가 없습니다. 제공된 정보에는 "
            "generateCommitAnalysis 프롬프트 구성만 있고, 변경된 호출부나 결과 소비부, "
            "실패 및 반환 동작이 없어 회귀 범위를 판단할 수 없습니다."
        )
        analysis = {"questions": [strong_question(), review_question], "contextFiles": []}
        answers = [
            {"questionId": "q1", "answer": "src/api/route.ts의 POST 함수가 request.json을 호출한 뒤 handle 결과를 반환합니다."},
            {"questionId": "q4", "answer": challenge},
        ]
        fallback = build_fallback_quiz_evaluation(analysis, answers, True)
        parsed = {
            "summary": "parsed",
            "strengths": ["코드 분석 범위의 한계를 이해했습니다."],
            "weaknesses": ["Q4에서 제공된 코드의 맥락을 과소평가하여 답변을 회피했습니다."],
            "reviewFiles": ["lib/ai.ts"],
            "questionEvaluations": [
                {"questionId": "q1", "score": 70, "scoreReason": "ok", "understood": ["POST 흐름"]},
                {"questionId": "q4", "score": 85, "scoreReason": "안정", "understood": ["제공된 정보의 범위"]},
            ],
        }

        result = normalize_quiz_evaluation(parsed, fallback, analysis["questions"])
        q4 = next(item for item in result["questionEvaluations"] if item["questionId"] == "q4")
        graded = [item for item in result["questionEvaluations"] if item.get("evaluationStatus", "graded") == "graded"]

        self.assertEqual(q4["answerType"], "question_challenge")
        self.assertEqual(q4["evaluationStatus"], "invalid_question")
        self.assertIn("회귀 위험", q4["invalidReason"])
        self.assertEqual(q4["score"], 0)
        self.assertEqual(q4["understood"], [])
        self.assertEqual(result["averageScore"], 70)
        self.assertEqual([item["questionId"] for item in graded], ["q1"])
        self.assertEqual(min(graded, key=lambda item: item["score"])["questionId"], "q1")
        self.assertNotIn("제공된 정보의 범위", result["strengths"])
        self.assertFalse(any("Q4" in item for item in result["weaknesses"]))
        self.assertNotIn("lib/ai.ts", result["reviewFiles"])

    def test_normal_branch_and_return_do_not_prove_regression_scope(self):
        question = {
            "id": "q4",
            "type": "리뷰형",
            "question": "buildFallbackCommitQuizEvaluation의 폴백 로직이 실제 LLM 평가를 대체하기에 충분한가요?",
            "relatedFiles": ["lib/ai.ts"],
            "evidenceSnippets": [{
                "id": "ai:fallback",
                "path": "lib/ai.ts",
                "title": "lib/ai.ts · buildFallbackCommitQuizEvaluation",
                "reason": "정상 fallback 평가 생성 과정",
                "excerpt": (
                    "function buildFallbackCommitQuizEvaluation(analysis, answers) {\n"
                    "  if (!analysis.questions.length) return emptyEvaluation();\n"
                    "  const evaluations = analysis.questions.map(buildFallbackEvaluation);\n"
                    "  return { averageScore: average(evaluations), questionEvaluations: evaluations };\n"
                    "}"
                ),
                "kind": "service",
                "quality": "strong",
            }],
        }
        answer = "제공된 코드에는 호출부와 결과 소비부가 없어 회귀 위험을 판단할 수 없습니다."

        self.assertEqual(classify_answer(answer), "question_challenge")
        self.assertIn("회귀 위험", invalid_question_reason(question, answer))
        result = build_fallback_quiz_evaluation({"questions": [question], "contextFiles": []}, [{"questionId": "q4", "answer": answer}], True)
        self.assertEqual(result["questionEvaluations"][0]["evaluationStatus"], "invalid_question")
        self.assertEqual(result["strengths"], [])

    def test_regression_scope_accepts_connected_test_or_failure_evidence(self):
        base = {
            "question": "이 변경의 회귀 위험을 어떻게 설명하나요?",
            "evidenceSnippets": [],
        }
        test_question = {**base, "evidenceSnippets": [{"excerpt": "def test_fallback():\n    assert evaluate() == expected"}]}
        failure_question = {**base, "evidenceSnippets": [{"excerpt": "try:\n    return evaluate()\nexcept ValueError:\n    raise HTTPException(status_code=400)"}]}
        connected_question = {**base, "evidenceSnippets": [
            {"id": "caller", "path": "route.ts", "title": "route.ts · POST", "excerpt": "function POST() { return evaluate(); }"},
            {"id": "callee", "path": "evaluation.ts", "title": "evaluation.ts · evaluate", "excerpt": "function evaluate() { return result; }"},
        ]}

        self.assertIsNone(question_capability_gap(test_question))
        self.assertIsNone(question_capability_gap(failure_question))
        self.assertIsNone(question_capability_gap(connected_question))

    def test_valid_regression_challenge_is_graded_low_without_strengths(self):
        question = {
            "id": "q4",
            "type": "테스트/리스크",
            "question": "실패 경로와 회귀 위험을 어떻게 설명하나요?",
            "relatedFiles": ["route.ts"],
            "evidenceSnippets": [{
                "id": "route-error",
                "path": "route.ts",
                "title": "route.ts · POST",
                "reason": "명시적 실패 처리",
                "excerpt": "try { return run(); } catch (error) { throw new HTTPException(413); }",
                "kind": "modified",
                "quality": "strong",
            }],
        }
        answer = "제공된 코드에는 호출부와 결과 소비부가 없어 회귀 위험을 판단할 수 없습니다."

        result = build_fallback_quiz_evaluation({"questions": [question], "contextFiles": []}, [{"questionId": "q4", "answer": answer}], True)
        evaluation = result["questionEvaluations"][0]

        self.assertEqual(evaluation["evaluationStatus"], "graded")
        self.assertEqual(evaluation["answerType"], "question_challenge")
        self.assertLessEqual(evaluation["score"], 20)
        self.assertEqual(evaluation["understood"], [])
        self.assertEqual(result["strengths"], [])

    def test_valid_question_dont_know_remains_insufficient(self):
        question = strong_question()
        result = build_fallback_quiz_evaluation(
            {"questions": [question], "contextFiles": []},
            [{"questionId": "q1", "answer": "모르겠습니다."}],
            False,
        )
        evaluation = result["questionEvaluations"][0]

        self.assertEqual(evaluation["answerType"], "insufficient")
        self.assertEqual(evaluation["evaluationStatus"], "graded")
        self.assertLessEqual(evaluation["score"], 10)

    def test_truncated_broad_question_is_not_answerable(self):
        question = {
            "question": "evaluate_answer는 LLM 프롬프트에 어떤 데이터를 조합하나요?",
            "evidenceSnippets": [{
                "excerpt": "def evaluate_answer(answer):\n    packet = build_packet(answer)\n\n... 이후 코드 생략 ..."
            }],
        }

        self.assertIn("생략", question_capability_gap(question))

    def test_fallback_failure_question_requires_failure_evidence(self):
        question = {
            "question": "build_fallback_commit_analysis 자체가 실패하는 상황에서는 어떤 결과가 반환되나요?",
            "evidenceSnippets": [{
                "excerpt": "def build_fallback_commit_analysis(context):\n    return build_analysis(context)"
            }],
        }
        self.assertIn("실패", question_capability_gap(question))

    def test_prompt_and_url_questions_require_complete_evidence_scope(self):
        prompt_question = {
            "question": "generateAnalysis는 프롬프트에 어떤 데이터를 조합해 반환하나요?",
            "evidenceSnippets": [{
                "excerpt": (
                    "def generate_analysis(context):\n"
                    "    if not context.files:\n        return fallback\n"
                    "    prompt = f\"\"\"Files: {context.files}\\nQuestion: {context.question}\"\"\"\n"
                    "    result = call_provider(prompt)\n"
                    "    return result\n"
                )
            }],
        }
        url_question = {
            "question": "parse_url의 URL 검증 제약은 무엇인가요?",
            "evidenceSnippets": [{
                "excerpt": (
                    "def parse_url(value):\n"
                    "    parsed = urlparse(value)\n"
                    "    if parsed.scheme != 'https':\n        raise ValueError('https only')\n"
                    "    if parsed.hostname != 'github.com':\n        raise ValueError('github only')\n"
                    "    return parsed.path\n"
                )
            }],
        }

        self.assertIsNone(question_capability_gap(prompt_question))
        self.assertIsNone(question_capability_gap(url_question))
        truncated_prompt = {**prompt_question, "evidenceSnippets": [{"excerpt": "def generate_analysis(context):\n    prompt = f\"{context.files}\"\n\n... 이후 코드 생략 ..."}]}
        one_condition_url = {**url_question, "evidenceSnippets": [{"excerpt": "if parsed.hostname != 'github.com':\n    raise ValueError()"}]}
        self.assertIsNotNone(question_capability_gap(truncated_prompt))
        self.assertIsNotNone(question_capability_gap(one_condition_url))

    def test_korean_particles_for_code_fragment(self):
        self.assertEqual(with_korean_particle("코드 조각", "은", "는"), "코드 조각은")
        self.assertEqual(with_korean_particle("코드 조각", "을", "를"), "코드 조각을")

    def test_http_method_acronym_is_not_treated_as_constant(self):
        self.assertFalse(has_unlinked_constant_subject(strong_question()))
        self.assertTrue(has_unlinked_constant_subject(constant_question()))

    def test_invalid_constant_question_overrides_llm_score_and_strength(self):
        analysis = {"questions": [strong_question(), constant_question()], "contextFiles": []}
        answers = [
            {"questionId": "q1", "answer": "src/api/route.ts의 POST 함수가 request.json을 호출한 뒤 handle 결과를 반환합니다."},
            {"questionId": "q2", "answer": "제공된 근거만으로 실제 분석 과정에 미치는 영향은 확인할 수 없습니다."},
        ]
        fallback = build_fallback_quiz_evaluation(analysis, answers, False)
        parsed = {
            "summary": "parsed",
            "strengths": ["상수 선언을 정확히 확인했습니다."],
            "weaknesses": [],
            "reviewFiles": [],
            "questionEvaluations": [
                {"questionId": "q1", "score": 70, "scoreReason": "ok", "understood": ["POST 흐름"]},
                {"questionId": "q2", "score": 85, "scoreReason": "ok", "understood": ["상수 선언 확인"]},
            ],
        }

        result = normalize_quiz_evaluation(parsed, fallback, analysis["questions"])
        invalid = result["questionEvaluations"][1]

        self.assertEqual(invalid["evaluationStatus"], "invalid_question")
        self.assertEqual(invalid["score"], 0)
        self.assertEqual(invalid["understood"], [])
        self.assertEqual(result["averageScore"], 70)
        self.assertNotIn("상수 선언 확인", result["strengths"])
        self.assertNotIn("상수 선언을 정확히 확인했습니다.", result["strengths"])

    def test_response_models_preserve_quality_and_invalid_status(self):
        evidence = CodeEvidence(
            id="constant",
            path="src/constants.ts",
            title="src/constants.ts · MAX_FILES",
            reason="limit",
            excerpt="export const MAX_FILES = 10;",
            kind="config",
            quality="conditional",
        )
        evaluation = {
            "averageScore": 0,
            "summary": "평가 제외",
            "strengths": [],
            "weaknesses": [],
            "reviewFiles": [],
            "questionEvaluations": [{
                "questionId": "q1",
                "score": 0,
                "scoreReason": "제외",
                "understood": [],
                "missing": [],
                "incorrect": [],
                "relatedFiles": ["src/constants.ts"],
                "reviewCode": ["src/constants.ts"],
                "betterAnswer": "평가하지 않습니다.",
                "interviewAnswerDirection": "근거 오류를 설명합니다.",
                "followUpQuestion": "다시 분석할까요?",
                "evaluationStatus": "invalid_question",
                "answerType": "question_challenge",
                "invalidReason": "상수-only 근거",
                "evidenceReferences": [{"path": "src/constants.ts", "scope": "MAX_FILES", "finding": "사용처 없음"}],
            }],
        }
        response = EvaluateQuizResponse(evaluation=evaluation)

        self.assertEqual(evidence.quality, "conditional")
        self.assertEqual(response.evaluation.questionEvaluations[0].evaluationStatus, "invalid_question")
        self.assertEqual(response.evaluation.questionEvaluations[0].answerType, "question_challenge")

    def test_repo_constant_symbol_stays_conditional_when_excerpt_contains_function(self):
        excerpt = "export const MAX_FILES = 10;\n\nexport function analyze(files) { return files.slice(0, 2); }"

        self.assertEqual(classify_repo_evidence("src/analyze.ts", "MAX_FILES", excerpt), "conditional")

    @patch("app.services.llm.call_configured_provider")
    def test_insufficient_analysis_skips_llm(self, provider):
        repo_fallback = {"questions": [], "ai": {"provider": "fallback", "used": False, "reason": "분석 가능한 실행 흐름이 부족합니다."}}
        commit_fallback = {"questions": [], "ai": {"provider": "fallback", "used": False, "reason": "분석 가능한 실행 흐름이 부족합니다."}}

        self.assertIs(generate_repo_analysis({}, repo_fallback), repo_fallback)
        self.assertIs(generate_commit_analysis({}, commit_fallback), commit_fallback)
        provider.assert_not_called()


if __name__ == "__main__":
    unittest.main()
