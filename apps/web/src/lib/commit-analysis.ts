import type { CodeEvidence, CommitAnalysisResult, CommitFileChange, CommitInfo, FileSummary } from "./types";
import { redactSecrets } from "./redaction";

const MAX_CONTEXT_FILES = 12;
const MAX_PATCH_EXCERPT = 2_400;
const MAX_EVIDENCE_SNIPPETS = 18;
const MAX_HUNK_EXCERPT = 1_800;
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
  const firstPath = keyFiles[0]?.path ?? "변경 파일";
  const secondPath = keyFiles[1]?.path ?? firstPath;
  const thirdPath = keyFiles[2]?.path ?? secondPath;
  const fourthPath = keyFiles[3]?.path ?? firstPath;
  const fallbackEvidence = [
    pickEvidenceForPath(context.evidenceSnippets, firstPath),
    pickEvidenceForPath(context.evidenceSnippets, secondPath),
    pickEvidenceForPath(context.evidenceSnippets, thirdPath),
    pickEvidenceForPath(context.evidenceSnippets, fourthPath)
  ];

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
    questions: [
      {
        id: "q1",
        type: "변경 의도",
        question: `${firstPath} 변경은 어떤 문제를 해결하려는 의도인가요?`,
        relatedFiles: [firstPath],
        evidenceSnippets: compactEvidenceList([fallbackEvidence[0]])
      },
      {
        id: "q2",
        type: "변경 영향도",
        question: `${secondPath} 변경이 연결된 기능이나 모듈에 어떤 영향을 줄 수 있나요?`,
        relatedFiles: [secondPath],
        evidenceSnippets: compactEvidenceList([fallbackEvidence[1]])
      },
      {
        id: "q3",
        type: "테스트/리스크",
        question: `${thirdPath} 변경 후 어떤 테스트나 예외 케이스를 확인해야 하나요?`,
        relatedFiles: [thirdPath],
        evidenceSnippets: compactEvidenceList([fallbackEvidence[2]])
      },
      {
        id: "q4",
        type: "리뷰형",
        question: `코드 리뷰에서 ${fourthPath} 변경의 책임 분리, 예외 처리, 회귀 위험 중 무엇을 질문받을 수 있나요?`,
        relatedFiles: [fourthPath],
        evidenceSnippets: compactEvidenceList([fallbackEvidence[3]])
      }
    ]
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
    return hunks.length ? hunks.map((hunk) => toCodeEvidence(file, hunk)) : [toCodeEvidence(file, null)];
  });

  return snippets.sort((a, b) => scoreCommitFileByPath(b.path, b.excerpt) - scoreCommitFileByPath(a.path, a.excerpt)).slice(0, MAX_EVIDENCE_SNIPPETS);
}

function toCodeEvidence(
  file: CommitFileChange,
  hunk: { index: number; header: string; excerpt: string } | null
): CodeEvidence {
  const header = hunk?.header ?? "patch unavailable";
  return {
    id: `${sanitizeEvidenceId(file.path)}:${hunk?.index ?? 0}`,
    path: file.path,
    title: `${file.path} ${header}`,
    reason: inferCommitFileReason(file),
    excerpt: hunk?.excerpt ?? fallbackEvidenceExcerpt(file),
    kind: file.status
  };
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
