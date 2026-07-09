import type { AnalysisFocus, AnalysisResult, CodeEvidence, FileSummary, QuestionLevel, QuestionType, RepoInfo, SourceFile } from "./types";
import { extractCodeSignals } from "./code-signals";
import { redactSecrets } from "./redaction";

const PRIORITY_PATTERNS = [
  /README/i,
  /^package\.json$/,
  /^(backend|frontend|src|app|pages|components|lib|server|routes|api)\//,
  /(route|router|controller|service|repository|entity|model|schema|store|auth|config)/i
];
const MAX_EXCERPT_LENGTH = 1_600;
const MAX_EVIDENCE_SNIPPETS = 24;
const MAX_REPO_SNIPPET_LENGTH = 1_200;
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
  const evidenceSnippets = buildRepoEvidenceSnippets(selectedFiles, focus, questionTargets);
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
    evidenceSnippets,
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
  packageInfo: Record<string, unknown> | null,
  evidenceSnippets: CodeEvidence[] = []
): AnalysisResult {
  const stack = inferStack(packageInfo, contextFiles);
  const keyFiles = contextFiles.slice(0, 6);
  const signals = extractCodeSignals(contextFiles, focus);
  const requestEvidence = pickEvidenceByCapability(evidenceSnippets, supportsRequestOrServiceEvidence, ["entry", "service"], 3);
  const dataEvidence = pickEvidenceByCapability(evidenceSnippets, supportsDataFlowEvidence, ["data", "service", "entry"], 3);
  const structureFile = pickSummaryFile(contextFiles, ["entry", "ui", "service", "config"])?.path ?? signals[0]?.path ?? keyFiles[0]?.path ?? "핵심 파일";
  const requestFiles = evidencePaths(requestEvidence);
  if (!requestFiles.length) requestFiles.push(...pickSummaryFiles(contextFiles, ["entry", "service"], 2).map((file) => file.path));
  const dataFiles = evidencePaths(dataEvidence);
  if (!dataFiles.length) dataFiles.push(...pickSummaryFiles(contextFiles, ["data", "service"], 2).map((file) => file.path));
  const impactFiles = pickSummaryFiles(contextFiles, ["service", "ui", "entry", "config"], 2).map((file) => file.path);
  const interviewFiles = pickSummaryFiles(contextFiles, ["entry", "service", "data", "config"], 2).map((file) => file.path);
  const secondaryFile = requestFiles[0] ?? keyFiles[1]?.path ?? structureFile;
  const dataFile = dataFiles[0] ?? structureFile;

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
    evidenceSnippets,
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
        question: `${structureFile}의 역할을 기준으로 이 프로젝트의 실행 진입점과 주요 폴더 구조를 설명해주세요.`,
        relatedFiles: [structureFile],
        evidenceSnippets: compactEvidenceList([pickEvidenceForPath(evidenceSnippets, structureFile)])
      },
      {
        id: "q2",
        type: questionTypes[1 % questionTypes.length] ?? "요청 흐름",
        question: `${secondaryFile}에서 시작되는 요청 또는 화면 흐름이 어떤 파일들과 연결되는지 설명해주세요.`,
        relatedFiles: requestFiles.length ? requestFiles : [secondaryFile],
        evidenceSnippets: compactEvidenceList(requestEvidence.length ? requestEvidence : (requestFiles.length ? requestFiles : [secondaryFile]).map((path) => pickEvidenceForPath(evidenceSnippets, path)))
      },
      {
        id: "q3",
        type: questionTypes[2 % questionTypes.length] ?? "데이터 흐름",
        question: `${dataFile}에서 데이터 입력, 검증, 조회 또는 저장 흐름이 어떻게 드러나는지 설명해주세요.`,
        relatedFiles: dataFiles.length ? dataFiles : [structureFile],
        evidenceSnippets: compactEvidenceList(dataEvidence.length ? dataEvidence : (dataFiles.length ? dataFiles : [structureFile]).map((path) => pickEvidenceForPath(evidenceSnippets, path)))
      },
      {
        id: "q4",
        type: questionTypes[3 % questionTypes.length] ?? "변경 영향도",
        question: `${structureFile}의 동작을 수정한다면 어떤 영향 범위를 함께 확인해야 하나요?`,
        relatedFiles: impactFiles.length ? impactFiles : [structureFile],
        evidenceSnippets: compactEvidenceList((impactFiles.length ? impactFiles : [structureFile]).map((path) => pickEvidenceForPath(evidenceSnippets, path)))
      },
      {
        id: "q5",
        type: questionTypes[4 % questionTypes.length] ?? "면접형",
        question: `면접이나 코드리뷰에서 ${secondaryFile}를 근거로 설계 의도와 위험 지점을 어떻게 설명하겠습니까?`,
        relatedFiles: interviewFiles.length ? interviewFiles : [secondaryFile],
        evidenceSnippets: compactEvidenceList((interviewFiles.length ? interviewFiles : [secondaryFile]).map((path) => pickEvidenceForPath(evidenceSnippets, path)))
      }
    ]
  };
}

function buildRepoEvidenceSnippets(files: SourceFile[], focus: AnalysisFocus, questionTargets: string[]): CodeEvidence[] {
  const guaranteed: CodeEvidence[] = [];
  const extras: CodeEvidence[] = [];

  for (const file of files) {
    const snippets = toRepoFileEvidence(file, focus, questionTargets);
    if (snippets[0]) guaranteed.push(snippets[0]);
    extras.push(...snippets.slice(1));
  }

  return dedupeEvidence([...guaranteed, ...extras.sort((a, b) => scoreRepoEvidence(b) - scoreRepoEvidence(a))]).slice(0, Math.max(MAX_EVIDENCE_SNIPPETS, guaranteed.length));
}

function toRepoFileEvidence(file: SourceFile, focus: AnalysisFocus, questionTargets: string[]): CodeEvidence[] {
  const content = redactSecrets(file.content);
  const chunks: Array<{ title: string; excerpt: string }> = [
    { title: "file overview", excerpt: content.slice(0, MAX_REPO_SNIPPET_LENGTH) },
    ...extractSymbolChunks(content).slice(0, 3),
    ...extractKeywordChunks(content, file.path).slice(0, 3)
  ];

  return chunks.filter((chunk) => chunk.excerpt.trim()).map((chunk, index) => ({
    id: `${sanitizeEvidenceId(file.path)}:${index}`,
    path: file.path,
    title: `${file.path} ${chunk.title}`,
    reason: inferFileReason(file.path),
    excerpt: chunk.excerpt.slice(0, MAX_REPO_SNIPPET_LENGTH),
    kind: fileLayer(file.path)
  }));
}

function extractSymbolChunks(content: string): Array<{ title: string; excerpt: string }> {
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm,
    /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)/gm,
    /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/gm,
    /^\s*def\s+([A-Za-z0-9_]+)\s*\(/gm,
    /^\s*class\s+([A-Za-z0-9_]+)/gm
  ];
  const chunks: Array<{ title: string; excerpt: string }> = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      chunks.push({ title: match[1] ?? "symbol", excerpt: sliceAround(content, match.index ?? 0, MAX_REPO_SNIPPET_LENGTH) });
      if (chunks.length >= 6) return chunks;
    }
  }
  return chunks;
}

function extractKeywordChunks(content: string, path: string): Array<{ title: string; excerpt: string }> {
  const keywordGroups: Array<{ title: string; pattern: RegExp }> = [
    { title: "error handling", pattern: /\b(except|catch|raise|throw|HTTPError|URLError|ValueError|Exception)\b/i },
    { title: "request flow", pattern: /\b(Request|fetch|urlopen|router|route|controller|handler|GET|POST|PUT|PATCH|DELETE)\b/i },
    { title: "data flow", pattern: /\b(schema|model|repository|entity|database|query|save|create|update|delete|find|fetch|parse|validate)\b/i }
  ];

  if (isConfigFile(path)) {
    keywordGroups.unshift({ title: "configuration", pattern: /\b(os\.getenv|BaseSettings|Settings|config|env|secret|token|key)\b/i });
  }

  const chunks: Array<{ title: string; excerpt: string }> = [];
  const seenRanges = new Set<number>();
  for (const group of keywordGroups) {
    const match = group.pattern.exec(content);
    if (!match || match.index === undefined) continue;
    const rangeKey = Math.floor(Math.max(match.index - MAX_REPO_SNIPPET_LENGTH / 2, 0) / 160);
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);
    chunks.push({ title: group.title, excerpt: sliceAround(content, match.index, MAX_REPO_SNIPPET_LENGTH) });
  }
  return chunks;
}

function sanitizeEvidenceId(path: string): string {
  return path.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function scoreRepoEvidence(snippet: CodeEvidence): number {
  let score = snippet.excerpt.length / 100;
  if (!snippet.title.endsWith("file overview")) score += 18;
  if (/function|class|return|async|await|fetch|router|route|controller|service|repository/i.test(snippet.excerpt)) score += 16;
  return score;
}

function pickEvidenceForPath(snippets: CodeEvidence[], path: string): CodeEvidence | undefined {
  return snippets.find((snippet) => snippet.path === path);
}

function compactEvidenceList(snippets: Array<CodeEvidence | undefined>): CodeEvidence[] {
  return [...new Map(snippets.filter((snippet): snippet is CodeEvidence => Boolean(snippet)).map((snippet) => [snippet.id, snippet])).values()].slice(0, 3);
}

function pickEvidenceByCapability(
  snippets: CodeEvidence[],
  predicate: (snippet: CodeEvidence) => boolean,
  layers: CodeEvidence["kind"][],
  limit: number
): CodeEvidence[] {
  const selected: CodeEvidence[] = [];
  for (const layer of layers) {
    const snippet = snippets.find((candidate) => candidate.kind === layer && predicate(candidate) && !selected.includes(candidate));
    if (snippet) selected.push(snippet);
    if (selected.length >= limit) return selected;
  }
  for (const snippet of snippets) {
    if (predicate(snippet) && !selected.includes(snippet)) selected.push(snippet);
    if (selected.length >= limit) break;
  }
  return selected;
}

function evidencePaths(snippets: CodeEvidence[]): string[] {
  return [...new Set(snippets.map((snippet) => snippet.path).filter(Boolean))];
}

function supportsRequestOrServiceEvidence(snippet: CodeEvidence): boolean {
  return supportsRequestFlowEvidence(snippet) || snippet.kind === "service";
}

function supportsRequestFlowEvidence(snippet: CodeEvidence): boolean {
  const text = `${snippet.path}\n${snippet.title}\n${snippet.excerpt}`;
  if (snippet.kind === "config" && /package\.json|config|env|settings|docker/i.test(snippet.path)) return false;
  return /route|router|controller|handler|endpoint|api\//i.test(snippet.path)
    || /\b(GET|POST|PUT|PATCH|DELETE|Request|Response|APIRouter|FastAPI|fetch\w*|urlopen|axios|NextRequest|NextResponse)\b/i.test(text);
}

function supportsDataFlowEvidence(snippet: CodeEvidence): boolean {
  const text = `${snippet.path}\n${snippet.title}\n${snippet.excerpt}`;
  if (snippet.kind === "config") return false;
  if (/tally|analytics|track\(/i.test(text) && !/\b(fetch|axios|save|query|repository|database|request\.json|FormData|localStorage)\b/i.test(text)) {
    return false;
  }
  return ["data", "service", "entry"].includes(snippet.kind)
    && /\b(schema|model|repository|entity|database|query\w*|save\w*|create\w*|update\w*|delete\w*|find\w*|fetch\w*|parse\w*|validate\w*|request\.json|response\.json|json\.loads|FormData|localStorage)\b/i.test(text);
}

function dedupeEvidence(snippets: CodeEvidence[]): CodeEvidence[] {
  return [...new Map(snippets.map((snippet) => [snippet.id, snippet])).values()];
}

function rankFiles(files: SourceFile[], focus: AnalysisFocus, questionTargets: string[] = []): SourceFile[] {
  return [...files].sort((a, b) => scoreFile(b, focus, questionTargets) - scoreFile(a, focus, questionTargets));
}

function selectContextFiles(files: SourceFile[], focus: AnalysisFocus, questionTargets: string[]): SourceFile[] {
  const runtimeCandidates = rankFiles(files.filter((file) => !isTestFile(file.path)), focus, questionTargets);

  if (focus === "balanced") {
    const diverseFiles = selectDiverseFiles(runtimeCandidates, ["entry", "service", "data", "ui", "config"], 3);
    return [...diverseFiles, ...runtimeCandidates.filter((file) => !diverseFiles.includes(file))].slice(0, 15);
  }

  const primaryLimit = 11;
  const complementLimit = 2;
  const focusedFiles = runtimeCandidates.filter((file) => matchesFocus(file.path, focus));
  const diversePrimaryFiles = selectDiverseFiles(focusedFiles, ["entry", "service", "data", "ui", "config"], 3);
  const primaryFiles = [...diversePrimaryFiles, ...focusedFiles.filter((file) => !diversePrimaryFiles.includes(file))].slice(0, primaryLimit);
  const complementFiles = selectDiverseFiles(runtimeCandidates.filter((file) => !primaryFiles.includes(file) && !matchesFocus(file.path, focus)), ["entry", "service", "data", "ui", "config"], 1).slice(0, complementLimit);
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
  return /(^|\/)(frontend|client|web|pages|components|views|screens|ui)(\/|$)|(^|\/)src\/app\/|\.(tsx|jsx|vue|svelte|astro)$/i.test(path);
}

function isServerFacingFile(path: string): boolean {
  return /(^|\/)(backend|server|api|routes|controllers?|services?|repositories?|entities?|models?|domain|infra|config)(\/|$)|\.(java|kt|go|py|rb|php|cs|rs)$/i.test(path);
}

function isEntrypointFile(path: string): boolean {
  return /(^|\/)(app\/api|src\/app\/api|pages\/api|routes?|controllers?|endpoints?)\/.+\.(py|ts|tsx|js|jsx|java|kt|go|rs)$/i.test(path)
    || /(^|\/)(route|router|controller|handler)\.(py|ts|tsx|js|jsx)$/i.test(path)
    || /(^|\/)[A-Za-z0-9_.-]*(route|router|controller|handler|endpoint)[A-Za-z0-9_.-]*\.(py|ts|tsx|js|jsx|java|kt|go|rs)$/i.test(path);
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
  return /(^|\/)(components|pages|views|screens|ui)(\/|$)|(^|\/)src\/app\/|page\.(tsx|jsx|ts|js)$|component/i.test(path);
}

function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx|java|kt)$/i.test(path);
}

function selectDiverseFiles(files: SourceFile[], layers: Array<ReturnType<typeof fileLayer>>, perLayer: number): SourceFile[] {
  const selected: SourceFile[] = [];
  for (const layer of layers) {
    for (const file of files.filter((candidate) => fileLayer(candidate.path) === layer).slice(0, perLayer)) {
      if (!selected.includes(file)) selected.push(file);
    }
  }
  return selected;
}

function pickSummaryFile(files: FileSummary[], layers: Array<ReturnType<typeof fileLayer>>): FileSummary | undefined {
  return pickSummaryFiles(files, layers, 1)[0] ?? files[0];
}

function pickSummaryFiles(files: FileSummary[], layers: Array<ReturnType<typeof fileLayer>>, limit: number): FileSummary[] {
  const selected: FileSummary[] = [];
  for (const layer of layers) {
    for (const file of files) {
      if (fileLayer(file.path) === layer && !selected.includes(file)) selected.push(file);
      if (selected.length >= limit) return selected;
    }
  }
  for (const file of files) {
    if (!selected.includes(file)) selected.push(file);
    if (selected.length >= limit) return selected;
  }
  return selected;
}

function fileLayer(path: string): "entry" | "service" | "data" | "ui" | "config" | "test" | "other" {
  if (isEntrypointFile(path)) return "entry";
  if (isUiFile(path)) return "ui";
  if (isBusinessLogicFile(path)) return "service";
  if (isDataAccessFile(path)) return "data";
  if (isConfigFile(path) || /auth|security|middleware|error|exception/i.test(path)) return "config";
  if (isTestFile(path)) return "test";
  return "other";
}

function toFileSummary(file: SourceFile): FileSummary {
  return {
    path: file.path,
    reason: inferFileReason(file.path),
    excerpt: buildSmartExcerpt(redactSecrets(file.content))
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
