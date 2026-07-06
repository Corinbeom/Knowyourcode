import type { CommitAnalysisResult, CommitFileChange, CommitInfo, FileSummary } from "./types";

const MAX_CONTEXT_FILES = 12;
const MAX_PATCH_EXCERPT = 2_400;

export type CommitStaticContext = {
  commit: CommitInfo;
  files: CommitFileChange[];
  totalAdditions: number;
  totalDeletions: number;
  contextFiles: FileSummary[];
};

export function buildCommitStaticContext(input: {
  commit: CommitInfo;
  files: CommitFileChange[];
  totalAdditions: number;
  totalDeletions: number;
}): CommitStaticContext {
  const rankedFiles = [...input.files].sort((a, b) => scoreCommitFile(b) - scoreCommitFile(a));
  const contextFiles = rankedFiles.slice(0, MAX_CONTEXT_FILES).map(toCommitFileSummary);

  return {
    commit: input.commit,
    files: input.files,
    totalAdditions: input.totalAdditions,
    totalDeletions: input.totalDeletions,
    contextFiles
  };
}

export function buildFallbackCommitAnalysis(context: CommitStaticContext): CommitAnalysisResult {
  const keyFiles = context.contextFiles.slice(0, 6);
  const firstPath = keyFiles[0]?.path ?? "변경 파일";
  const secondPath = keyFiles[1]?.path ?? firstPath;
  const thirdPath = keyFiles[2]?.path ?? secondPath;
  const fourthPath = keyFiles[3]?.path ?? firstPath;

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
        relatedFiles: [firstPath]
      },
      {
        id: "q2",
        type: "변경 영향도",
        question: `${secondPath} 변경이 연결된 기능이나 모듈에 어떤 영향을 줄 수 있나요?`,
        relatedFiles: [secondPath]
      },
      {
        id: "q3",
        type: "테스트/리스크",
        question: `${thirdPath} 변경 후 어떤 테스트나 예외 케이스를 확인해야 하나요?`,
        relatedFiles: [thirdPath]
      },
      {
        id: "q4",
        type: "리뷰형",
        question: `코드 리뷰에서 ${fourthPath} 변경의 책임 분리, 예외 처리, 회귀 위험 중 무엇을 질문받을 수 있나요?`,
        relatedFiles: [fourthPath]
      }
    ]
  };
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
    excerpt: `${header}\n${file.patch ? file.patch.slice(0, MAX_PATCH_EXCERPT) : "(GitHub API에서 diff patch를 제공하지 않는 파일입니다.)"}`
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
