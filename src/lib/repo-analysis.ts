import type { AnalysisResult, FileSummary, RepoInfo, SourceFile } from "./types";
import { extractCodeSignals } from "./code-signals";

const PRIORITY_PATTERNS = [
  /README/i,
  /^package\.json$/,
  /^(src|app|pages|components|lib|server|routes|api)\//,
  /(route|router|controller|service|model|schema|store|auth|config)/i
];

export function buildStaticContext(repo: RepoInfo, files: SourceFile[]) {
  const selectedFiles = selectContextFiles(files);
  const contextFiles = selectedFiles.map(toFileSummary);
  const tree = summarizeTree(files);
  const packageJson = files.find((file) => file.path === "package.json");

  return {
    repo,
    fileCount: files.length,
    contextFiles,
    tree,
    packageInfo: packageJson ? safeParsePackageJson(packageJson.content) : null
  };
}

export function buildFallbackAnalysis(
  repo: RepoInfo,
  fileCount: number,
  contextFiles: FileSummary[],
  tree: string[],
  packageInfo: Record<string, unknown> | null
): AnalysisResult {
  const stack = inferStack(packageInfo, contextFiles);
  const keyFiles = contextFiles.slice(0, 6);
  const signals = extractCodeSignals(contextFiles);
  const primarySignal = signals[0];
  const secondarySignal = signals[1] ?? primarySignal;
  const tertiarySignal = signals[2] ?? secondarySignal;
  const primaryFile = primarySignal?.path ?? keyFiles[0]?.path ?? "핵심 파일";
  const secondaryFile = secondarySignal?.path ?? keyFiles[1]?.path ?? primaryFile;
  const tertiaryFile = tertiarySignal?.path ?? keyFiles[2]?.path ?? secondaryFile;

  return {
    repo,
    analyzedAt: new Date().toISOString(),
    fileCount,
    ai: {
      provider: "fallback",
      used: false,
      reason: "LLM 응답을 사용하지 못해 기본 분석으로 대체했습니다."
    },
    contextFiles,
    report: {
      oneLineSummary: `${repo.repo} 저장소의 구조와 핵심 파일을 기반으로 한 초기 코드 이해도 분석입니다.`,
      techStack: stack,
      folderStructure: tree.slice(0, 12),
      coreFeatures: ["README와 주요 소스 파일을 기준으로 핵심 기능을 확인해야 합니다."],
      requestFlow: "라우트/API/서버 진입점 파일을 중심으로 요청 흐름을 추적하세요.",
      dataFlow: "데이터 접근 계층, API 호출, 상태 관리 파일을 중심으로 데이터 흐름을 확인하세요.",
      keyFiles,
      difficulty: contextFiles.length > 18 ? "어려움" : contextFiles.length > 8 ? "보통" : "쉬움",
      riskyQuestions: [
        "이 프로젝트의 실행 진입점은 어디인가요?",
        "핵심 기능 하나를 수정하려면 어떤 파일들을 함께 봐야 하나요?",
        "README에 적힌 기술 스택이 실제 코드에서 어디에 사용되나요?"
      ]
    },
    questions: [
      {
        id: "q1",
        type: "구조 이해",
        question: `${primaryFile}의 역할을 기준으로 이 프로젝트의 실행 진입점과 주요 폴더 구조를 설명해주세요.`,
        relatedFiles: [primaryFile, secondaryFile, tertiaryFile]
      },
      {
        id: "q2",
        type: "요청 흐름",
        question: `${secondaryFile}에서 시작되는 요청 또는 화면 흐름이 어떤 파일들과 연결되는지 설명해주세요.`,
        relatedFiles: [secondaryFile, primaryFile, tertiaryFile]
      },
      {
        id: "q3",
        type: "데이터 흐름",
        question: `${tertiaryFile}를 보면 데이터가 어디에서 들어오고 어디로 전달되는지 어떻게 추론할 수 있나요?`,
        relatedFiles: [tertiaryFile, primaryFile, secondaryFile]
      },
      {
        id: "q4",
        type: "변경 영향도",
        question: `${primaryFile}의 동작을 수정한다면 ${secondaryFile}와 함께 어떤 영향 범위를 확인해야 하나요?`,
        relatedFiles: [primaryFile, secondaryFile, tertiaryFile]
      },
      {
        id: "q5",
        type: "면접형",
        question: `면접에서 ${primaryFile}와 ${secondaryFile}를 근거로 이 프로젝트의 핵심 구조를 어떻게 설명하겠습니까?`,
        relatedFiles: [primaryFile, secondaryFile]
      }
    ]
  };
}

function rankFiles(files: SourceFile[]): SourceFile[] {
  return [...files].sort((a, b) => scoreFile(b.path) - scoreFile(a.path));
}

function selectContextFiles(files: SourceFile[]): SourceFile[] {
  const runtimeFiles = rankFiles(files.filter((file) => !isTestFile(file.path))).slice(0, 10);
  const supportFiles = rankFiles(files.filter((file) => isTestFile(file.path))).slice(0, 1);
  return [...runtimeFiles, ...supportFiles].slice(0, 11);
}

function scoreFile(path: string): number {
  let score = 0;
  for (const pattern of PRIORITY_PATTERNS) {
    if (pattern.test(path)) score += 10;
  }
  if (path.split("/").length <= 2) score += 3;
  if (/app\/api\/|pages\/api\/|route\.(ts|tsx|js|jsx)$|router|controller/i.test(path)) score += 18;
  if (/service|lib|auth|repository|model|schema|store|db|database/i.test(path)) score += 14;
  if (/page\.(tsx|jsx|ts|js)$|component|components\//i.test(path)) score += 10;
  if (isTestFile(path)) score -= 35;
  return score;
}

function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(path);
}

function toFileSummary(file: SourceFile): FileSummary {
  return {
    path: file.path,
    reason: inferFileReason(file.path),
    excerpt: file.content.slice(0, 600)
  };
}

function inferFileReason(path: string): string {
  if (/README/i.test(path)) return "프로젝트 설명과 실행 방법을 확인할 수 있는 파일";
  if (path === "package.json") return "기술 스택, 실행 스크립트, 의존성을 확인할 수 있는 파일";
  if (/route|router|api/i.test(path)) return "요청 진입점과 API 흐름을 확인할 수 있는 파일";
  if (/component|page/i.test(path)) return "사용자 화면과 UI 흐름을 확인할 수 있는 파일";
  if (/service|lib|util/i.test(path)) return "비즈니스 로직 또는 공통 로직을 확인할 수 있는 파일";
  if (/test|spec/i.test(path)) return "테스트 범위와 기대 동작을 확인할 수 있는 파일";
  return "프로젝트 구조 이해에 참고할 수 있는 파일";
}

function summarizeTree(files: SourceFile[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length === 1) {
      folders.add(file.path);
      continue;
    }
    folders.add(parts.slice(0, Math.min(parts.length - 1, 2)).join("/"));
  }
  return [...folders].sort().slice(0, 30);
}

function safeParsePackageJson(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function inferStack(packageInfo: Record<string, unknown> | null, files: FileSummary[]): string[] {
  const stack = new Set<string>();
  const dependencies = {
    ...((packageInfo?.dependencies as Record<string, string> | undefined) ?? {}),
    ...((packageInfo?.devDependencies as Record<string, string> | undefined) ?? {})
  };

  if (dependencies.next) stack.add("Next.js");
  if (dependencies.react) stack.add("React");
  if (dependencies.express) stack.add("Express");
  if (dependencies.typescript || files.some((file) => file.path.endsWith(".ts") || file.path.endsWith(".tsx"))) {
    stack.add("TypeScript");
  }
  if (dependencies.prisma) stack.add("Prisma");
  if (dependencies.tailwindcss) stack.add("Tailwind CSS");
  if (!stack.size) stack.add("JavaScript/TypeScript");

  return [...stack];
}
