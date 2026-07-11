import { describe, expect, it } from "vitest";

import { buildCommitStaticContext, buildFallbackCommitAnalysis } from "./commit-analysis";

function contextFixture() {
  return buildCommitStaticContext({
    commit: {
      owner: "acme",
      repo: "demo",
      sha: "abc123",
      shortSha: "abc123",
      url: "https://github.com/acme/demo/commit/abc123",
      message: "normalize commit files",
      author: "tester",
      committedAt: "2026-01-01T00:00:00Z"
    },
    files: [
      {
        path: "src/lib/ai.ts",
        status: "modified",
        additions: 6,
        deletions: 0,
        changes: 6,
        patch: [
          "@@ -10,4 +10,5 @@ function normalizeCommitChangedFiles(input) {",
          "   const previousContext = true;",
          "+  if (!input) return [];",
          "   return input;",
          "@@ -40,3 +41,4 @@ function normalizeCommitQuestions(input) {",
          "+  if (!input.length) return [];",
          "   return input;",
          "@@ -70,3 +72,4 @@ function normalizeCommitReport(input) {",
          "+  if (!input) return emptyReport();",
          "   return input;"
        ].join("\n")
      }
    ],
    totalAdditions: 6,
    totalDeletions: 0
  });
}

describe("commit evidence scope", () => {
  it("labels same-file hunks by function and starts previews at declarations", () => {
    const context = contextFixture();

    expect(context.evidenceSnippets.map((snippet) => snippet.title).sort()).toEqual([
      "src/lib/ai.ts · normalizeCommitChangedFiles",
      "src/lib/ai.ts · normalizeCommitQuestions",
      "src/lib/ai.ts · normalizeCommitReport"
    ].sort());
    expect(context.evidenceSnippets.every((snippet) => snippet.excerpt.startsWith("function normalizeCommit"))).toBe(true);
  });

  it("uses a normal input/result test question when no failure path exists", () => {
    const analysis = buildFallbackCommitAnalysis(contextFixture());
    const testQuestion = analysis.questions.find((question) => question.type === "테스트/리스크");

    expect(testQuestion?.question).toContain("정상 분기와 반환 동작");
    expect(testQuestion?.question).not.toContain("예외 케이스");
  });

  it("prefers a changed function over the previous hunk context", () => {
    const context = buildCommitStaticContext({
      ...contextFixture(),
      files: [{
        path: "src/lib/ai.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        changes: 3,
        patch: [
          "@@ -10,4 +10,8 @@ function normalizeKeyFiles(input) {",
          "   return input;",
          "+function normalizeCommitChangedFiles(files) {",
          "+  if (!files) return [];",
          "+}"
        ].join("\n")
      }]
    });

    expect(context.evidenceSnippets[0].title).toBe("src/lib/ai.ts · normalizeCommitChangedFiles");
    expect(context.evidenceSnippets[0].excerpt.startsWith("+function normalizeCommitChangedFiles")).toBe(true);
  });
});
