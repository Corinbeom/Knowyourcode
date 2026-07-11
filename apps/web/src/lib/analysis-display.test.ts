import { describe, expect, it } from "vitest";

import { commitAnalysisTitle, repoAnalysisTitle } from "./analysis-display";
import { upsertQuizAnswer } from "./analysis-session";

describe("analysis display", () => {
  it("uses compact repository and commit titles instead of full URLs", () => {
    expect(repoAnalysisTitle("https://github.com/Corinbeom/Knowyourcode.git")).toBe("Corinbeom/Knowyourcode");
    expect(commitAnalysisTitle("https://github.com/Corinbeom/Knowyourcode/commit/ef8eb65abcdef")).toBe("Corinbeom/Knowyourcode@ef8eb65");
  });

  it("falls back safely for unsupported URLs", () => {
    expect(repoAnalysisTitle("not-a-url")).toBe("저장소 분석");
    expect(commitAnalysisTitle("https://example.com/repo/commit/abc")).toBe("커밋 분석");
  });
});

describe("commit quiz draft", () => {
  it("persists the current draft without dropping previous answers", () => {
    const answers = upsertQuizAnswer([{ questionId: "q1", answer: "첫 답변" }], "q2", "작성 중 draft");

    expect(answers).toEqual([
      { questionId: "q1", answer: "첫 답변" },
      { questionId: "q2", answer: "작성 중 draft" }
    ]);
    expect(upsertQuizAnswer(answers, "q2", "수정한 draft").find((item) => item.questionId === "q2")?.answer).toBe("수정한 draft");
  });
});
