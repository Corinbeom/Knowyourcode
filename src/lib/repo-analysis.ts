import type { AnalysisFocus, AnalysisResult, FileSummary, QuestionLevel, QuestionType, RepoInfo, SourceFile } from "./types";
import { extractCodeSignals } from "./code-signals";

const PRIORITY_PATTERNS = [
  /README/i,
  /^package\.json$/,
  /^(backend|frontend|src|app|pages|components|lib|server|routes|api)\//,
  /(route|router|controller|service|repository|entity|model|schema|store|auth|config)/i
];
const MAX_EXCERPT_LENGTH = 1_600;
const SECTION_EXCERPT_LENGTH = 360;
const SYMBOL_CONTEXT_LENGTH = 420;
const MAX_SYMBOL_SNIPPETS = 2;

export function buildStaticContext(
  repo: RepoInfo,
  files: SourceFile[],
  focus: AnalysisFocus = "balanced",
  questionLevel: QuestionLevel = "standard",
  questionTypes: QuestionType[] = ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"],
  questionTargets: string[] = []
) {
  const selectedFiles = selectContextFiles(files, focus, questionTargets);
  const contextFiles = selectedFiles.map(toFileSummary);
  const tree = summarizeTree(files);
  const packageJson = files.find((file) => file.path === "package.json");

  return {
    repo,
    focus,
    questionLevel,
    questionTypes,
    questionTargets,
    fileCount: files.length,
    contextFiles,
    tree,
    packageInfo: packageJson ? safeParsePackageJson(packageJson.content) : null
  };
}

export function buildFallbackAnalysis(
  repo: RepoInfo,
  fileCount: number,
  focus: AnalysisFocus,
  questionLevel: QuestionLevel,
  questionTypes: QuestionType[],
  questionTargets: string[],
  contextFiles: FileSummary[],
  tree: string[],
  packageInfo: Record<string, unknown> | null
): AnalysisResult {
  const stack = inferStack(packageInfo, contextFiles);
  const keyFiles = contextFiles.slice(0, 6);
  const signals = extractCodeSignals(contextFiles, focus);
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
    focus,
    questionLevel,
    questionTypes,
    questionTargets,
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
        type: questionTypes[0] ?? "구조 이해",
        question: `${primaryFile}의 역할을 기준으로 이 프로젝트의 실행 진입점과 주요 폴더 구조를 설명해주세요.`,
        relatedFiles: [primaryFile, secondaryFile, tertiaryFile]
      },
      {
        id: "q2",
        type: questionTypes[1 % questionTypes.length] ?? "요청 흐름",
        question: `${secondaryFile}에서 시작되는 요청 또는 화면 흐름이 어떤 파일들과 연결되는지 설명해주세요.`,
        relatedFiles: [secondaryFile, primaryFile, tertiaryFile]
      },
      {
        id: "q3",
        type: questionTypes[2 % questionTypes.length] ?? "데이터 흐름",
        question: `${tertiaryFile}를 보면 데이터가 어디에서 들어오고 어디로 전달되는지 어떻게 추론할 수 있나요?`,
        relatedFiles: [tertiaryFile, primaryFile, secondaryFile]
      },
      {
        id: "q4",
        type: questionTypes[3 % questionTypes.length] ?? "변경 영향도",
        question: `${primaryFile}의 동작을 수정한다면 ${secondaryFile}와 함께 어떤 영향 범위를 확인해야 하나요?`,
        relatedFiles: [primaryFile, secondaryFile, tertiaryFile]
      },
      {
        id: "q5",
        type: questionTypes[4 % questionTypes.length] ?? "면접형",
        question: `면접에서 ${primaryFile}와 ${secondaryFile}를 근거로 이 프로젝트의 핵심 구조를 어떻게 설명하겠습니까?`,
        relatedFiles: [primaryFile, secondaryFile]
      }
    ]
  };
}

function rankFiles(files: SourceFile[], focus: AnalysisFocus, questionTargets: string[] = []): SourceFile[] {
  return [...files].sort((a, b) => scoreFile(b, focus, questionTargets) - scoreFile(a, focus, questionTargets));
}

function selectContextFiles(files: SourceFile[], focus: AnalysisFocus, questionTargets: string[]): SourceFile[] {
  const runtimeCandidates = rankFiles(files.filter((file) => !isTestFile(file.path)), focus, questionTargets);

  if (focus === "balanced") {
    const frontendFiles = runtimeCandidates.filter((file) => isClientFacingFile(file.path)).slice(0, 5);
    const backendFiles = runtimeCandidates.filter((file) => isServerFacingFile(file.path)).slice(0, 5);
    const sharedFiles = runtimeCandidates
      .filter((file) => !frontendFiles.includes(file) && !backendFiles.includes(file))
      .filter((file) => !isClientFacingFile(file.path) && !isServerFacingFile(file.path))
      .slice(0, 4);
    const supportFiles = rankFiles(files.filter((file) => isTestFile(file.path)), focus, questionTargets).slice(0, 1);
    return [...frontendFiles, ...backendFiles, ...sharedFiles, ...supportFiles].slice(0, 15);
  }

  const primaryLimit = 11;
  const complementLimit = 2;
  const primaryFiles = runtimeCandidates.filter((file) => matchesFocus(file.path, focus)).slice(0, primaryLimit);
  const complementFiles = runtimeCandidates
    .filter((file) => !primaryFiles.includes(file))
    .filter((file) => !matchesFocus(file.path, focus))
    .slice(0, complementLimit);
  return [...primaryFiles, ...complementFiles].slice(0, 15);
}

function scoreFile(file: SourceFile, focus: AnalysisFocus, questionTargets: string[]): number {
  const path = file.path;
  let score = 0;
  for (const pattern of PRIORITY_PATTERNS) {
    if (pattern.test(path)) score += 10;
  }
  if (path.split("/").length <= 2) score += 3;
  if (isEntrypointFile(path)) score += 18;
  if (isBusinessLogicFile(path)) score += 16;
  if (isDataAccessFile(path)) score += 14;
  if (isConfigFile(path)) score += 10;
  if (isUiFile(path)) score += 10;
  if (matchesFocus(path, focus)) score += 18;
  score += scoreQuestionTargetMatch(file, questionTargets);
  if (isTestFile(path)) score -= 35;
  return score;
}

function scoreQuestionTargetMatch(file: SourceFile, questionTargets: string[]): number {
  if (!questionTargets.length) return 0;

  const haystack = `${file.path}\n${file.content.slice(0, 4_000)}`.toLowerCase();
  let score = 0;

  for (const term of expandQuestionTargetTerms(questionTargets)) {
    if (!term) continue;
    if (file.path.toLowerCase().includes(term)) score += 22;
    if (haystack.includes(term)) score += 12;
  }

  return Math.min(score, 60);
}

function expandQuestionTargetTerms(questionTargets: string[]): string[] {
  const terms = new Set<string>();

  for (const target of questionTargets) {
    const normalized = target.toLowerCase();
    terms.add(normalized);
    for (const token of normalized.split(/[\s/_-]+/)) {
      if (token.length >= 2) terms.add(token);
    }

    if (/로그인|인증|회원|계정|권한|보안/.test(target)) {
      ["auth", "login", "user", "account", "token", "security", "permission"].forEach((term) => terms.add(term));
    }
    if (/ai|면접|질문|어시스턴트|assistant/i.test(target)) {
      ["ai", "interview", "question", "assistant", "gemini", "llm"].forEach((term) => terms.add(term));
    }
    if (/이력서|자소서|포트폴리오|resume/i.test(target)) {
      ["resume", "portfolio", "profile", "cover"].forEach((term) => terms.add(term));
    }
    if (/지원|공고|채용|application|tracker/i.test(target)) {
      ["application", "tracker", "job", "posting", "recruit"].forEach((term) => terms.add(term));
    }
    if (/퀴즈|cs|문제|quiz/i.test(target)) {
      ["quiz", "cs", "problem", "question"].forEach((term) => terms.add(term));
    }
  }

  return [...terms];
}

function matchesFocus(path: string, focus: AnalysisFocus): boolean {
  if (focus === "balanced") return true;
  if (focus === "frontend") return isClientFacingFile(path);
  return isServerFacingFile(path);
}

function isClientFacingFile(path: string): boolean {
  return /(^|\/)(frontend|client|web|app|pages|components|views|screens|ui)(\/|$)|\.(tsx|jsx|vue|svelte|astro)$/i.test(path);
}

function isServerFacingFile(path: string): boolean {
  return /(^|\/)(backend|server|api|routes|controllers?|services?|repositories?|entities?|models?|domain|infra|config)(\/|$)|\.(java|kt|go|py|rb|php|cs|rs)$/i.test(path);
}

function isEntrypointFile(path: string): boolean {
  return /(^|\/)(api|routes?|controllers?)(\/|$)|route\.(ts|tsx|js|jsx)$|router|controller|handler/i.test(path);
}

function isBusinessLogicFile(path: string): boolean {
  return /service|usecase|interactor|command|handler|domain|auth|security/i.test(path);
}

function isDataAccessFile(path: string): boolean {
  return /repository|entity|model|schema|store|db|database|dao|mapper|prisma/i.test(path);
}

function isConfigFile(path: string): boolean {
  return /config|\.config\.|package\.json|build\.gradle|settings\.gradle|pom\.xml|application\.(yml|yaml|properties)|docker/i.test(path);
}

function isUiFile(path: string): boolean {
  return /(^|\/)(components|pages|app|views|screens|ui)(\/|$)|page\.(tsx|jsx|ts|js)$|component/i.test(path);
}

function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx|java|kt)$/i.test(path);
}

function toFileSummary(file: SourceFile): FileSummary {
  return {
    path: file.path,
    reason: inferFileReason(file.path),
    excerpt: buildSmartExcerpt(file.content)
  };
}

function buildSmartExcerpt(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.length <= MAX_EXCERPT_LENGTH) return normalized;

  const sections = [
    formatExcerptSection("head", normalized.slice(0, SECTION_EXCERPT_LENGTH)),
    formatExcerptSection("middle", sliceAround(normalized, Math.floor(normalized.length / 2), SECTION_EXCERPT_LENGTH)),
    formatExcerptSection("tail", normalized.slice(-SECTION_EXCERPT_LENGTH))
  ];

  const symbolSnippets = findSymbolSnippetPositions(normalized)
    .filter((position) => position > SECTION_EXCERPT_LENGTH)
    .slice(0, MAX_SYMBOL_SNIPPETS)
    .map((position, index) => formatExcerptSection(`symbol ${index + 1}`, sliceAround(normalized, position, SYMBOL_CONTEXT_LENGTH)));

  return dedupeExcerptSections([...sections, ...symbolSnippets]).join("\n\n").slice(0, MAX_EXCERPT_LENGTH);
}

function formatExcerptSection(label: string, text: string): string {
  return `[${label}]\n${text.trim()}`;
}

function sliceAround(content: string, index: number, length: number): string {
  const half = Math.floor(length / 2);
  const start = Math.max(index - half, 0);
  const end = Math.min(start + length, content.length);
  return content.slice(start, end);
}

function findSymbolSnippetPositions(content: string): number[] {
  const patterns = [
    /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b/g,
    /\b(?:public|private|protected)\s+(?:static\s+)?[A-Za-z0-9_<>, ?.[\]]+\s+[A-Za-z0-9_]+\s*\(/g,
    /\bexport\s+(?:async\s+)?function\s+[A-Za-z0-9_]+/g,
    /\bexport\s+const\s+[A-Za-z0-9_]+/g,
    /\bconst\s+[A-Za-z0-9_]+\s*=\s*(?:async\s*)?\(/g,
    /\bfunction\s+[A-Za-z0-9_]+\s*\(/g,
    /\bclass\s+[A-Za-z0-9_]+/g,
    /\breturn\s*\(/g
  ];

  const positions: number[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (typeof match.index === "number") positions.push(match.index);
    }
  }

  return [...new Set(positions)].sort((a, b) => a - b);
}

function dedupeExcerptSections(sections: string[]): string[] {
  const seen = new Set<string>();
  return sections.filter((section) => {
    const compact = section.replace(/\s+/g, " ").slice(0, 120);
    if (seen.has(compact)) return false;
    seen.add(compact);
    return true;
  });
}

function inferFileReason(path: string): string {
  if (/README/i.test(path)) return "프로젝트 설명과 실행 방법을 확인할 수 있는 파일";
  if (isConfigFile(path)) return "기술 스택, 실행 설정, 배포 구성을 확인할 수 있는 파일";
  if (isEntrypointFile(path)) return "요청 진입점과 API 흐름을 확인할 수 있는 파일";
  if (isBusinessLogicFile(path)) return "비즈니스 로직과 기능 흐름을 확인할 수 있는 파일";
  if (isDataAccessFile(path)) return "데이터 모델과 저장소 접근 흐름을 확인할 수 있는 파일";
  if (isUiFile(path)) return "사용자 화면과 UI 흐름을 확인할 수 있는 파일";
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
  if (files.some((file) => file.path.endsWith(".java"))) stack.add("Java");
  if (files.some((file) => file.path.endsWith(".py"))) stack.add("Python");
  if (files.some((file) => file.path.endsWith(".go"))) stack.add("Go");
  if (files.some((file) => file.path.endsWith(".cs"))) stack.add("C#");
  if (files.some((file) => /SpringApplication|@SpringBootApplication/i.test(file.excerpt))) stack.add("Spring Boot");
  if (files.some((file) => /FastAPI|from fastapi|import fastapi/i.test(file.excerpt))) stack.add("FastAPI");
  if (files.some((file) => /express\(|from ['"]express|require\(['"]express/i.test(file.excerpt))) stack.add("Express");
  if (!stack.size) stack.add("JavaScript/TypeScript");

  return [...stack];
}
