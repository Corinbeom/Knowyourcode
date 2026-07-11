import type { CodeEvidence, CommitAnalysisResult, CommitFileChange, CommitInfo, FileSummary } from "./types";
import { redactSecrets } from "./redaction";

const MAX_CONTEXT_FILES = 12;
const MAX_PATCH_EXCERPT = 2_400;
const MAX_EVIDENCE_SNIPPETS = 18;
const MAX_HUNK_EXCERPT = 1_800;
const MIN_COMMIT_QUESTIONS = 2;
const OMITTED_AFTER_DIFF_MARKER = "... 이후 변경 내용 생략 ...";

export type CommitStaticContext = {
  commit: CommitInfo;
  files: CommitFileChange[];
  totalAdditions: number;
  totalDeletions: number;
  contextFiles: FileSummary[];
  evidenceSnippets: CodeEvidence[];
};

export function buildCommitStaticContext(input: {
  commit: CommitInfo;
  files: CommitFileChange[];
  totalAdditions: number;
  totalDeletions: number;
}): CommitStaticContext {
  const rankedFiles = [...input.files].sort((a, b) => scoreCommitFile(b) - scoreCommitFile(a));
  const contextFiles = rankedFiles.slice(0, MAX_CONTEXT_FILES).map(toCommitFileSummary);
  const evidenceSnippets = buildCommitEvidenceSnippets(rankedFiles);

  return {
    commit: input.commit,
    files: input.files,
    totalAdditions: input.totalAdditions,
    totalDeletions: input.totalDeletions,
    contextFiles,
    evidenceSnippets
  };
}

export function buildFallbackCommitAnalysis(context: CommitStaticContext): CommitAnalysisResult {
  const keyFiles = context.contextFiles.slice(0, 6);
  const questionEvidence = strongCommitEvidence(context.evidenceSnippets);
  if (questionEvidence.length < MIN_COMMIT_QUESTIONS) {
    return {
      commit: context.commit,
      analyzedAt: new Date().toISOString(),
      fileCount: context.files.length,
      totalAdditions: context.totalAdditions,
      totalDeletions: context.totalDeletions,
      ai: { provider: "fallback", used: false, reason: "분석 가능한 실행 흐름이 부족합니다." },
      contextFiles: keyFiles,
      evidenceSnippets: context.evidenceSnippets,
      report: {
        oneLineSummary: `${context.commit.shortSha} 커밋에서 질문으로 검증할 만한 substantive diff 근거가 충분하지 않습니다.`,
        changeIntent: "문서, 바이너리, patch unavailable, 상수-only 변경만으로는 변경 의도를 코드 흐름 기준으로 평가하지 않습니다.",
        impactScope: ["실행 함수, handler, service, 검증/변환 흐름이 포함된 diff를 분석해주세요."],
        riskAreas: ["분석 가능한 실행 흐름이 부족해 리뷰 위험 문항을 생성하지 않았습니다."],
        testSuggestions: ["substantive code diff가 있는 커밋으로 다시 분석해주세요."],
        changedFiles: keyFiles
      },
      questions: []
    };
  }
  const questionCount = Math.min(4, questionEvidence.length);
  const selectedEvidence = questionEvidence.slice(0, questionCount);
  const fallbackEvidence = [...selectedEvidence, ...Array(4).fill(selectedEvidence.at(-1))].slice(0, 4) as CodeEvidence[];
  const [firstPath, secondPath, thirdPath, fourthPath] = fallbackEvidence.map(commitEvidenceSubject);

  return {
    commit: context.commit,
    analyzedAt: new Date().toISOString(),
    fileCount: context.files.length,
    totalAdditions: context.totalAdditions,
    totalDeletions: context.totalDeletions,
    ai: {
      provider: "fallback",
      used: false,
      reason: "LLM 응답을 사용하지 못해 커밋 기본 분석으로 대체했습니다."
    },
    contextFiles: keyFiles,
    evidenceSnippets: context.evidenceSnippets,
    report: {
      oneLineSummary: `${context.commit.shortSha} 커밋의 변경 파일과 diff를 기반으로 한 코드 이해도 분석입니다.`,
      changeIntent: "커밋 메시지와 변경 파일을 기준으로 변경 의도를 직접 확인해야 합니다.",
      impactScope: keyFiles.map((file) => `${file.path} 변경 영향 확인`),
      riskAreas: ["변경된 파일의 호출 흐름과 테스트 보강 지점을 확인하세요."],
      testSuggestions: ["변경된 기능의 정상 흐름과 예외 흐름을 함께 검증하세요."],
      changedFiles: keyFiles
    },
    questions: compactQuestions([
      {
        id: "q1",
        type: "변경 의도" as const,
        question: `${firstPath} 변경은 어떤 문제를 해결하려는 의도인가요?`,
        relatedFiles: [firstPath],
        evidenceSnippets: compactEvidenceList([fallbackEvidence[0]])
      },
      {
        id: "q2",
        type: "변경 영향도" as const,
        question: `${secondPath} 변경이 연결된 기능이나 모듈에 어떤 영향을 줄 수 있나요?`,
        relatedFiles: [secondPath],
        evidenceSnippets: compactEvidenceList([fallbackEvidence[1]])
      },
      {
        id: "q3",
        type: "테스트/리스크" as const,
        question: `${thirdPath}의 정상 분기와 반환 동작을 검증하려면 어떤 입력과 결과를 확인해야 하나요?`,
        relatedFiles: [thirdPath],
        evidenceSnippets: compactEvidenceList([fallbackEvidence[2]])
      },
      {
        id: "q4",
        type: "리뷰형" as const,
        question: `코드 리뷰에서 ${fourthPath} 변경의 구현 의도와 선택한 구현 방식을 어떻게 설명하겠습니까?`,
        relatedFiles: [fourthPath],
        evidenceSnippets: compactEvidenceList([fallbackEvidence[3]])
      }
    ].slice(0, questionCount))
  };
}

function splitPatchHunks(file: CommitFileChange): Array<{ index: number; header: string; excerpt: string }> {
  if (!file.patch) return [];
  return redactSecrets(file.patch)
    .split(/(?=^@@ .+? @@)/m)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const firstLine = part.split("\n")[0] ?? "";
      return {
        index,
        header: firstLine.startsWith("@@") ? firstLine : `파일 변경 ${index + 1}`,
        excerpt: truncateDiffExcerpt(part, MAX_HUNK_EXCERPT)
      };
    });
}

function truncateDiffExcerpt(content: string, limit: number): string {
  if (content.length <= limit) return content;

  const available = Math.max(0, limit - OMITTED_AFTER_DIFF_MARKER.length - 1);
  const truncated = content.slice(0, available);
  const lastNewline = truncated.lastIndexOf("\n");
  const completeLines = lastNewline >= 0 ? truncated.slice(0, lastNewline) : truncated;
  return `${completeLines.trimEnd()}\n${OMITTED_AFTER_DIFF_MARKER}`;
}

function buildCommitEvidenceSnippets(files: CommitFileChange[]): CodeEvidence[] {
  const snippets = files.flatMap((file) => {
    const hunks = splitPatchHunks(file);
    return hunks.map((hunk) => toCodeEvidence(file, hunk));
  }).filter((snippet) => snippet.quality !== "weak");

  return snippets.sort((a, b) => scoreCommitFileByPath(b.path, b.excerpt) - scoreCommitFileByPath(a.path, a.excerpt)).slice(0, MAX_EVIDENCE_SNIPPETS);
}

function toCodeEvidence(
  file: CommitFileChange,
  hunk: { index: number; header: string; excerpt: string } | null
): CodeEvidence {
  const header = hunk?.header ?? "patch unavailable";
  const rawExcerpt = hunk?.excerpt ?? fallbackEvidenceExcerpt(file);
  const scope = commitHunkScope(header, rawExcerpt);
  const excerpt = normalizeCommitHunkExcerpt(header, rawExcerpt);
  return {
    id: `${sanitizeEvidenceId(file.path)}:${hunk?.index ?? 0}`,
    path: file.path,
    title: `${file.path} · ${scope || `hunk ${(hunk?.index ?? 0) + 1}`}`,
    reason: inferCommitFileReason(file),
    excerpt,
    kind: file.status,
    quality: classifyCommitEvidence(file.path, header, excerpt)
  };
}

function commitEvidenceSubject(snippet: CodeEvidence): string {
  const scope = snippet.title.includes("·") ? snippet.title.split("·").at(-1)?.trim() : "";
  return scope ? `${snippet.path}의 ${scope}` : snippet.path;
}

function commitHunkScope(header: string, excerpt: string): string {
  const headerContext = header.startsWith("@@") ? header.split("@@").at(-1)?.trim() ?? "" : "";
  return selectHunkDeclaration(excerpt.split("\n"), headerContext).scope;
}

function normalizeCommitHunkExcerpt(header: string, excerpt: string): string {
  const lines = excerpt.split("\n");
  const body = lines[0]?.startsWith("@@") ? lines.slice(1) : lines;
  const headerContext = header.startsWith("@@") ? header.split("@@").at(-1)?.trim() ?? "" : "";
  const selected = selectHunkDeclaration(body, headerContext);
  if (selected.index !== null) return body.slice(selected.index).join("\n").trim();
  if (selected.scope) return [headerContext, ...body].join("\n").trim();
  return excerpt;
}

function selectHunkDeclaration(lines: string[], headerContext: string): { index: number | null; scope: string } {
  const callables = lines
    .map((line, index) => ({ index, scope: declarationScope(line), kind: declarationKind(line), changed: /^[+-]/.test(line) }))
    .filter((item) => item.kind === "callable");
  const changedCallable = callables.find((item) => item.changed);
  if (changedCallable) return changedCallable;

  if (callables.length) {
    return callables
      .map((item, position) => {
        const end = callables[position + 1]?.index ?? lines.length;
        const changedCount = lines.slice(item.index, end).filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length;
        return { ...item, changedCount, position };
      })
      .sort((a, b) => b.changedCount - a.changedCount || b.position - a.position)[0];
  }

  const changedDeclaration = lines
    .map((line, index) => ({ index, scope: declarationScope(line), changed: /^[+-]/.test(line) }))
    .find((item) => item.changed && item.scope);
  return changedDeclaration ?? { index: null, scope: declarationScope(headerContext) };
}

function declarationScope(line: string): string {
  const code = line.replace(/^[ +\-]/, "").trim();
  const match = code.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\bdef\s+([A-Za-z_]\w*)|\bclass\s+([A-Za-z_]\w*)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
  return match?.slice(1).find(Boolean) ?? "";
}

function declarationKind(line: string): "callable" | "value" {
  const code = line.replace(/^[ +\-]/, "").trim();
  return /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$]|\b(?:def|class)\s+[A-Za-z_]/.test(code) ? "callable" : "value";
}

function classifyCommitEvidence(path: string, header: string, excerpt: string): "strong" | "conditional" | "weak" {
  if (!excerpt.trim() || header === "patch unavailable" || excerpt.includes("patch를 제공하지 않는 파일")) return "weak";
  if (/\.(md|mdx|txt|png|jpe?g|gif|svg|ico|lock)$/i.test(path)) return "weak";
  const changedLines = excerpt
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .map((line) => line.slice(1).trim())
    .join("\n");
  const meaningful = stripDiffNoise(changedLines);
  if (!meaningful.trim()) return "weak";
  if (isConstantOnlyChange(meaningful)) return "conditional";
  return hasSubstantiveDiffFlow(meaningful) ? "strong" : "conditional";
}

function stripDiffNoise(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(#|\/\/|\/\*|\*)/.test(line))
    .filter((line) => !/^(import|from\s+\S+\s+import|export\s+\{)/.test(line))
    .join("\n");
}

function isConstantOnlyChange(text: string): boolean {
  return /^(?:(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*[^;\n]+;?\s*)+$/.test(text.trim());
}

function hasSubstantiveDiffFlow(text: string): boolean {
  return /\b(function|def|class|async|await|return|if|elif|else|for|while|try|except|catch|throw|raise|with|yield)\b/.test(text)
    && /\w+\s*\(|return\s+|=>|request\.|response\.|fetch|query|save|create|update|delete|find|parse|validate/i.test(text);
}

function strongCommitEvidence(snippets: CodeEvidence[]): CodeEvidence[] {
  return snippets.filter((snippet) => snippet.quality === "strong");
}

function compactQuestions<T extends { evidenceSnippets?: CodeEvidence[] }>(questions: T[]): T[] {
  return questions.filter((question) => question.evidenceSnippets?.length);
}

function fallbackEvidenceExcerpt(file: CommitFileChange): string {
  return [
    `status: ${file.status}`,
    `additions: ${file.additions}`,
    `deletions: ${file.deletions}`,
    file.previousPath ? `previousPath: ${file.previousPath}` : "",
    "(GitHub API에서 diff patch를 제공하지 않는 파일입니다.)"
  ].filter(Boolean).join("\n");
}

function sanitizeEvidenceId(path: string): string {
  return path.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function scoreCommitFileByPath(path: string, excerpt: string): number {
  let score = excerpt.length > 0 ? Math.min(excerpt.length, 1_200) / 80 : 0;
  if (/service|controller|route|api|domain|repository|entity|model|schema|auth|security/i.test(path)) score += 40;
  if (/\.(ts|tsx|js|jsx|java|kt|py|go|rs)$/i.test(path)) score += 20;
  if (/function|class|def |return|throw|catch|async|await|export|import/.test(excerpt)) score += 20;
  if (/test|spec|__tests__/i.test(path)) score -= 25;
  return score;
}

function pickEvidenceForPath(snippets: CodeEvidence[], path: string): CodeEvidence | undefined {
  return snippets.find((snippet) => snippet.path === path) ?? snippets[0];
}

function compactEvidenceList(snippets: Array<CodeEvidence | undefined>): CodeEvidence[] {
  return [...new Map(snippets.filter((snippet): snippet is CodeEvidence => Boolean(snippet)).map((snippet) => [snippet.id, snippet])).values()];
}

function scoreCommitFile(file: CommitFileChange): number {
  let score = file.changes;
  if (/service|controller|route|api|domain|repository|entity|model|schema|auth|security/i.test(file.path)) score += 40;
  if (/\.(ts|tsx|js|jsx|java|kt|py|go|rs)$/i.test(file.path)) score += 20;
  if (/test|spec|__tests__/i.test(file.path)) score -= 25;
  if (!file.patch) score -= 20;
  return score;
}

function toCommitFileSummary(file: CommitFileChange): FileSummary {
  const header = [
    `status: ${file.status}`,
    `additions: ${file.additions}`,
    `deletions: ${file.deletions}`,
    file.previousPath ? `previousPath: ${file.previousPath}` : ""
  ].filter(Boolean).join("\n");

  return {
    path: file.path,
    reason: inferCommitFileReason(file),
    excerpt: `${header}\n${file.patch ? truncateDiffExcerpt(redactSecrets(file.patch), MAX_PATCH_EXCERPT) : "(GitHub API에서 diff patch를 제공하지 않는 파일입니다.)"}`
  };
}

function inferCommitFileReason(file: CommitFileChange): string {
  if (file.status === "added") return "이번 커밋에서 새로 추가된 파일입니다.";
  if (file.status === "removed") return "이번 커밋에서 제거된 파일입니다.";
  if (file.status === "renamed") return "이번 커밋에서 이름이 변경된 파일입니다.";
  if (/test|spec|__tests__/i.test(file.path)) return "변경 검증 범위를 확인할 수 있는 테스트 파일입니다.";
  if (/service|domain|usecase|handler/i.test(file.path)) return "변경 의도와 비즈니스 로직 영향을 확인할 핵심 파일입니다.";
  if (/controller|route|api/i.test(file.path)) return "요청 진입점 또는 API 흐름 영향을 확인할 파일입니다.";
  if (/component|page|screen|view|hook/i.test(file.path)) return "사용자 화면 또는 클라이언트 상태 영향을 확인할 파일입니다.";
  if (/config|security|auth/i.test(file.path)) return "설정, 인증, 운영 영향 가능성을 확인할 파일입니다.";
  return "이번 커밋에서 변경된 주요 파일입니다.";
}
