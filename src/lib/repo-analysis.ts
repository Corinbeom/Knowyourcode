import type { AnalysisResult, FileSummary, RepoInfo, SourceFile } from "./types";

const PRIORITY_PATTERNS = [
  /README/i,
  /^package\.json$/,
  /^(src|app|pages|components|lib|server|routes|api)\//,
  /(route|router|controller|service|model|schema|store|auth|config|test|spec)/i
];

export function buildStaticContext(repo: RepoInfo, files: SourceFile[]) {
  const selectedFiles = rankFiles(files).slice(0, 16);
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
        question: "이 프로젝트의 실행 진입점과 주요 폴더 역할을 설명해주세요.",
        relatedFiles: keyFiles.map((file) => file.path).slice(0, 3)
      },
      {
        id: "q2",
        type: "요청 흐름",
        question: "사용자 요청이 들어왔을 때 어떤 파일들을 거쳐 처리될 가능성이 높은가요?",
        relatedFiles: keyFiles.map((file) => file.path).slice(0, 3)
      },
      {
        id: "q3",
        type: "데이터 흐름",
        question: "외부 API, DB, 상태 관리 등 데이터가 이동하는 지점을 어디에서 확인할 수 있나요?",
        relatedFiles: keyFiles.map((file) => file.path).slice(0, 3)
      },
      {
        id: "q4",
        type: "변경 영향도",
        question: "핵심 기능 하나를 수정한다면 어떤 파일들을 함께 확인해야 하나요?",
        relatedFiles: keyFiles.map((file) => file.path).slice(0, 4)
      },
      {
        id: "q5",
        type: "면접형",
        question: "이 프로젝트를 면접에서 1분 안에 설명한다면 어떤 구조와 의도를 강조하겠습니까?",
        relatedFiles: keyFiles.map((file) => file.path).slice(0, 2)
      }
    ]
  };
}

function rankFiles(files: SourceFile[]): SourceFile[] {
  return [...files].sort((a, b) => scoreFile(b.path) - scoreFile(a.path));
}

function scoreFile(path: string): number {
  let score = 0;
  for (const pattern of PRIORITY_PATTERNS) {
    if (pattern.test(path)) score += 10;
  }
  if (path.split("/").length <= 2) score += 3;
  if (path.includes(".test.") || path.includes(".spec.")) score += 2;
  return score;
}

function toFileSummary(file: SourceFile): FileSummary {
  return {
    path: file.path,
    reason: inferFileReason(file.path),
    excerpt: file.content.slice(0, 1000)
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
