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
const MAX_REPO_SNIPPET_LENGTH = 2_400;
const MIN_PROJECT_QUESTIONS = 3;
const SECTION_EXCERPT_LENGTH = 360;
const SYMBOL_CONTEXT_LENGTH = 420;
const MAX_SYMBOL_SNIPPETS = 2;
const OMITTED_BEFORE_MARKER = "... 이전 코드 생략 ...";
const OMITTED_AFTER_MARKER = "... 이후 코드 생략 ...";

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
  const questionEvidence = strongRepoEvidence(evidenceSnippets);
  if (questionEvidence.length < MIN_PROJECT_QUESTIONS) {
    return {
      repo,
      analyzedAt: new Date().toISOString(),
      fileCount,
      focus,
      questionLevel,
      questionTypes,
      questionTargets,
      ai: { provider: "fallback", used: false, reason: "분석 가능한 실행 흐름이 부족합니다." },
      contextFiles,
      evidenceSnippets,
      report: {
        oneLineSummary: `${repo.repo} 저장소에서 질문으로 검증할 만한 실행 코드 근거가 충분하지 않습니다.`,
        techStack: stack,
        folderStructure: tree.slice(0, 12),
        coreFeatures: ["강한 실행 흐름 evidence가 부족해 코드 이해도 문항을 생성하지 않았습니다."],
        requestFlow: "라우트, handler, service처럼 호출/조건/반환이 드러나는 실행 흐름을 찾지 못했습니다.",
        dataFlow: "검증, 변환, 조회, 저장처럼 실제 코드 흐름으로 연결된 근거가 부족합니다.",
        keyFiles,
        difficulty: "어려움",
        riskyQuestions: ["분석 가능한 실행 흐름이 있는 소스 파일을 포함해 다시 분석해주세요."]
      },
      questions: []
    };
  }
  const questionCount = Math.min(5, questionEvidence.length);
  const requestEvidence = connectedRequestEvidence(
    pickEvidenceByCapability(questionEvidence, supportsRequestOrServiceEvidence, ["entry", "service"], 3)
  );
  if (!requestEvidence.length) requestEvidence.push(...questionEvidence.slice(0, 1));
  const dataEvidence = pickEvidenceByCapability(questionEvidence, supportsDataFlowEvidence, ["data", "service", "entry"], 3);
  if (!dataEvidence.length) dataEvidence.push(...questionEvidence.slice(0, 2));
  const requestFiles = evidencePaths(requestEvidence);
  const structureCandidate = questionEvidence.find((snippet) => ["entry", "service", "ui"].includes(snippet.kind)) ?? questionEvidence[0];
  const structureFile = structureCandidate.path;
  const dataFiles = evidencePaths(dataEvidence);
  const impactEvidence = connectedRequestEvidence(sortEvidenceByLayer(questionEvidence, ["service", "entry", "data", "ui", "other"]).slice(0, 2));
  const interviewEvidence = sortEvidenceByLayer(questionEvidence, ["entry", "service", "data", "ui", "other"]).slice(0, 2);
  const impactFiles = evidencePaths(impactEvidence);
  const interviewFiles = evidencePaths(interviewEvidence);
  const secondaryFile = requestFiles[0] ?? keyFiles[1]?.path ?? structureFile;
  const dataFile = dataFiles[0] ?? structureFile;
  const structureEvidence = compactEvidenceList([structureCandidate]);
  const structureSubject = structureEvidence[0] ? fallbackQuestionSubject(structureEvidence[0]) : `${structureFile}의 코드 조각`;

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
    questions: compactQuestions([
      {
        id: "q1",
        type: questionTypes[0] ?? "구조 이해",
        question: `${withKoreanParticle(structureSubject, "은", "는")} 선택된 코드 흐름에서 어떤 역할을 담당하나요?`,
        relatedFiles: [structureFile],
        evidenceSnippets: structureEvidence
      },
      {
        id: "q2",
        type: questionTypes[1 % questionTypes.length] ?? "요청 흐름",
        question: `${withKoreanParticle(secondaryFile, "을", "를")} 포함한 요청 또는 화면 흐름이 어떤 파일들과 연결되는지 설명해주세요.`,
        relatedFiles: requestFiles.length ? requestFiles : [secondaryFile],
        evidenceSnippets: compactEvidenceList(requestEvidence)
      },
      {
        id: "q3",
        type: questionTypes[2 % questionTypes.length] ?? "데이터 흐름",
        question: `${dataFile}에서 데이터 입력, 검증, 조회 또는 변환 흐름이 어떻게 드러나는지 설명해주세요.`,
        relatedFiles: dataFiles.length ? dataFiles : [structureFile],
        evidenceSnippets: compactEvidenceList(dataEvidence)
      },
      {
        id: "q4",
        type: questionTypes[3 % questionTypes.length] ?? "변경 영향도",
        question: `${structureFile}의 동작을 수정한다면 어떤 영향 범위를 함께 확인해야 하나요?`,
        relatedFiles: impactFiles.length ? impactFiles : [structureFile],
        evidenceSnippets: compactEvidenceList(impactEvidence)
      },
      {
        id: "q5",
        type: questionTypes[4 % questionTypes.length] ?? "면접형",
        question: `면접이나 코드리뷰에서 ${withKoreanParticle(secondaryFile, "을", "를")} 근거로 설계 의도와 위험 지점을 어떻게 설명하겠습니까?`,
        relatedFiles: interviewFiles.length ? interviewFiles : [secondaryFile],
        evidenceSnippets: compactEvidenceList(interviewEvidence)
      }
    ].slice(0, questionCount))
  };
}

function fallbackQuestionSubject(snippet: CodeEvidence): string {
  const scope = snippet.title.includes("·")
    ? snippet.title.split("·").at(-1)?.trim() ?? ""
    : snippet.path && snippet.title.startsWith(snippet.path)
      ? snippet.title.slice(snippet.path.length).replace(/^[\s·-]+/, "").trim()
      : "";
  if (!scope || scope === "file overview") return `${snippet.path}의 코드 조각`;
  if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(scope)) return `${snippet.path}의 ${scope} handler`;
  return `${snippet.path}의 ${scope} 코드`;
}

function withKoreanParticle(value: string, consonantParticle: string, vowelParticle: string): string {
  const trimmed = value.trimEnd();
  const last = trimmed.at(-1);
  if (!last) return value;
  const code = last.charCodeAt(0);
  const hasFinalConsonant = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return `${trimmed}${hasFinalConsonant ? consonantParticle : vowelParticle}`;
}

function buildRepoEvidenceSnippets(files: SourceFile[], focus: AnalysisFocus, questionTargets: string[]): CodeEvidence[] {
  const snippets: CodeEvidence[] = [];

  for (const file of files) {
    snippets.push(...toRepoFileEvidence(file, focus, questionTargets));
  }

  return dedupeEvidence(snippets.sort((a, b) => scoreRepoEvidence(b) - scoreRepoEvidence(a))).slice(0, MAX_EVIDENCE_SNIPPETS);
}

function toRepoFileEvidence(file: SourceFile, focus: AnalysisFocus, questionTargets: string[]): CodeEvidence[] {
  const content = redactSecrets(file.content);
  const codeChunks = rankRepoChunks([
    ...extractSymbolChunks(content).slice(0, 3),
    ...extractKeywordChunks(content, file.path).slice(0, 3)
  ], file.path);
  const chunks: Array<{ title: string; excerpt: string }> = codeChunks;

  return chunks
    .filter((chunk) => chunk.excerpt.trim())
    .map((chunk, index) => {
      const quality = classifyRepoEvidence(file.path, chunk.title, chunk.excerpt);
      return {
        id: `${sanitizeEvidenceId(file.path)}:${index}`,
        path: file.path,
        title: `${file.path} · ${chunk.title}`,
        reason: inferEvidenceReason(file.path, chunk.title, chunk.excerpt),
        excerpt: chunk.excerpt.slice(0, MAX_REPO_SNIPPET_LENGTH),
        kind: fileLayer(file.path),
        quality
      };
    })
    .filter((snippet) => snippet.quality !== "weak");
}

function classifyRepoEvidence(path: string, title: string, excerpt: string): "strong" | "conditional" | "weak" {
  const text = stripCommentsAndImports(excerpt);
  if (!text.trim()) return "weak";
  if (title === "file overview" || isDocOnlyPath(path)) return "weak";
  if (isConstantOnlyScope(title, text) || isNonExecutableConstantSymbol(title, text)) return "conditional";
  if (isContractLikePath(path) && !hasExecutableFlow(text)) return "conditional";
  if (hasExecutableFlow(text)) return "strong";
  return /\b(class|interface|type|schema|model|config|settings)\b/i.test(text) ? "conditional" : "weak";
}

function stripCommentsAndImports(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(#|\/\/|\/\*|\*|<!--)/.test(line))
    .filter((line) => !/^(import|from\s+\S+\s+import|export\s+\{)/.test(line))
    .join("\n");
}

function isDocOnlyPath(path: string): boolean {
  return /(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING)(\.[A-Za-z0-9]+)?$|\.mdx?$/i.test(path);
}

function isConstantOnlyScope(title: string, text: string): boolean {
  if (/^(runtime|dynamic|revalidate|preferredRegion|maxDuration|fetchCache|configuration)$/.test(title)) return true;
  return /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*[\s\S]+;?$/.test(text.trim());
}

function isNonExecutableConstantSymbol(title: string, text: string): boolean {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = text.match(new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escapedTitle}\\s*=\\s*([^\\n;]+)`));
  if (!declaration) return false;
  const initializer = declaration[1] ?? "";
  return !initializer.includes("=>") && !/\bfunction\b/.test(initializer);
}

function sortEvidenceByLayer(snippets: CodeEvidence[], layers: string[]): CodeEvidence[] {
  return [...snippets].sort((left, right) => {
    const leftIndex = layers.includes(left.kind) ? layers.indexOf(left.kind) : layers.length;
    const rightIndex = layers.includes(right.kind) ? layers.indexOf(right.kind) : layers.length;
    return leftIndex - rightIndex;
  });
}

function hasExecutableFlow(text: string): boolean {
  return /\b(function|def|class|async|await|return|if|elif|else|for|while|try|except|catch|throw|raise|with|yield)\b/.test(text)
    && /\w+\s*\(|return\s+|=>|request\.|response\.|fetch|query|save|create|update|delete|find|parse|validate/i.test(text);
}

function strongRepoEvidence(snippets: CodeEvidence[]): CodeEvidence[] {
  return snippets.filter((snippet) => snippet.quality === "strong");
}

function compactQuestions<T extends { evidenceSnippets?: CodeEvidence[] }>(questions: T[]): T[] {
  return questions.filter((question) => question.evidenceSnippets?.length);
}

function extractSymbolChunks(content: string): Array<{ title: string; excerpt: string }> {
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm,
    /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)/gm,
    /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/gm,
    /^\s*def\s+([A-Za-z0-9_]+)\s*\(/gm,
    /^\s*class\s+([A-Za-z0-9_]+)/gm
  ];
  const matches: Array<{ index: number; title: string }> = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      matches.push({ index: match.index ?? 0, title: match[1] ?? "symbol" });
    }
  }
  const chunks: Array<{ title: string; excerpt: string }> = [];
  const seen = new Set<string>();
  for (const match of matches.sort((a, b) => a.index - b.index)) {
    const key = `${match.index}:${match.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chunks.push({ title: match.title, excerpt: sliceSymbolForward(content, match.index, MAX_REPO_SNIPPET_LENGTH) });
    if (chunks.length >= 6) break;
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
    const symbolStart = findSymbolStartBefore(content, match.index);
    const start = symbolStart ?? Math.max(match.index - MAX_REPO_SNIPPET_LENGTH / 2, 0);
    const rangeKey = Math.floor(start / 160);
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);
    chunks.push({ title: group.title, excerpt: sliceSymbolForward(content, symbolStart ?? match.index, MAX_REPO_SNIPPET_LENGTH) });
  }
  return chunks;
}

function findSymbolStartBefore(content: string, index: number): number | undefined {
  const prefix = content.slice(0, index);
  const pattern = /^\s*(?:export\s+)?(?:async\s+)?(?:function|def|class)\s+[A-Za-z_][A-Za-z0-9_]*/gm;
  const arrowPattern = /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:async\s+)?(?:\([^\n]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>/gm;
  const matches = [...prefix.matchAll(pattern), ...prefix.matchAll(arrowPattern)].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  return matches.at(-1)?.index;
}

function rankRepoChunks(chunks: Array<{ title: string; excerpt: string }>, path: string): Array<{ title: string; excerpt: string }> {
  return chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort((a, b) => repoChunkPriority(a.chunk, path) - repoChunkPriority(b.chunk, path) || a.index - b.index)
    .map((item) => item.chunk);
}

function repoChunkPriority(chunk: { title: string; excerpt: string }, path: string): number {
  if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(chunk.title)) return 0;
  if (isEntrypointFile(path) && /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/.test(chunk.excerpt)) return 1;
  if (["runtime", "dynamic", "revalidate", "preferredRegion", "maxDuration", "fetchCache"].includes(chunk.title)) return 8;
  if (["request flow", "data flow", "error handling"].includes(chunk.title)) return 3;
  if (chunk.title === "configuration") return 7;
  if (chunk.title === "file overview") return 9;
  return 2;
}

function sanitizeEvidenceId(path: string): string {
  return path.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function scoreRepoEvidence(snippet: CodeEvidence): number {
  let score = snippet.excerpt.length / 100;
  if (snippet.title.endsWith("file overview")) score -= 24;
  else score += 18;
  if (/function|class|return|async|await|fetch|router|route|controller|service|repository/i.test(snippet.excerpt)) score += 16;
  return score;
}

function inferEvidenceReason(path: string, title: string, excerpt: string): string {
  if (title === "file overview") return inferFileReason(path);

  const text = `${path}\n${title}\n${excerpt}`;
  if (/\b(GET|POST|PUT|PATCH|DELETE|Request|Response|APIRouter|FastAPI|fetch\w*|urlopen|axios|NextRequest|NextResponse)\b|route|router|controller|handler|api\//i.test(text)) {
    return "요청 처리와 API/서비스 연결 흐름을 확인할 수 있는 코드 조각";
  }
  if (/\b(schema|model|repository|entity|database|query\w*|save\w*|create\w*|update\w*|delete\w*|find\w*|fetch\w*|parse\w*|validate\w*)\b/i.test(text)) {
    return "데이터 입력, 검증, 조회 또는 변환 흐름을 확인할 수 있는 코드 조각";
  }
  if (/\b(except|catch|raise|throw|HTTPError|URLError|ValueError|Exception)\b/i.test(text)) {
    return "예외 처리와 실패 경계를 확인할 수 있는 코드 조각";
  }
  return "선택된 함수나 클래스의 책임을 확인할 수 있는 코드 조각";
}

function pickEvidenceForPath(snippets: CodeEvidence[], path: string): CodeEvidence | undefined {
  return snippets.find((snippet) => snippet.path === path);
}

function compactEvidenceList(snippets: Array<CodeEvidence | undefined>): CodeEvidence[] {
  return [...new Map(snippets.filter((snippet): snippet is CodeEvidence => Boolean(snippet)).map((snippet) => [evidenceIdentity(snippet), snippet])).values()].slice(0, 3);
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
  return supportsRequestFlowEvidence(snippet) || isRequestHelperEvidence(snippet);
}

function connectedRequestEvidence(snippets: CodeEvidence[]): CodeEvidence[] {
  if (snippets.length <= 1) return snippets;
  const selected = [snippets[0]];
  const remaining = snippets.slice(1);
  const connectedTokens = requestConnectionTokens(snippets[0]);
  while (remaining.length) {
    const connectedIndex = remaining.findIndex((snippet) => [...requestConnectionTokens(snippet)].some((token) => connectedTokens.has(token)));
    if (connectedIndex < 0) break;
    const [snippet] = remaining.splice(connectedIndex, 1);
    const tokens = requestConnectionTokens(snippet);
      selected.push(snippet);
      tokens.forEach((token) => connectedTokens.add(token));
  }
  return selected;
}

function requestConnectionTokens(snippet: CodeEvidence): Set<string> {
  const text = `${snippet.title}\n${snippet.excerpt}`;
  const calls = [...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{3,})\s*\(/g)].map((match) => match[1].toLowerCase());
  const routes = [...text.matchAll(/["'](\/[-A-Za-z0-9_/{}/.]{3,})["']/g)].map((match) => match[1].toLowerCase());
  const imports = [...text.matchAll(/^\s*(?:import|from)\s+.*$/gm)].flatMap((match) => match[0].match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) ?? []).map((token) => token.toLowerCase());
  const scope = repoEvidenceScopeTitle(snippet);
  const stopWords = new Set(["function", "request", "response", "json", "fetch", "return", "str", "int", "list", "dict", "nextresponse", "import", "from"]);
  const scopeTokens = /^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(scope) ? [scope.toLowerCase()] : [];
  return new Set([...calls, ...routes, ...imports, ...scopeTokens].filter((token) => !stopWords.has(token)));
}

function repoEvidenceScopeTitle(snippet: CodeEvidence): string {
  if (snippet.title.includes("·")) return snippet.title.split("·").at(-1)?.trim() ?? "";
  if (snippet.path && snippet.title.startsWith(snippet.path)) return snippet.title.slice(snippet.path.length).replace(/^[\s·-]+/, "").trim();
  return "";
}

function supportsRequestFlowEvidence(snippet: CodeEvidence): boolean {
  const text = `${snippet.path}\n${snippet.title}\n${snippet.excerpt}`;
  if (isRouteConfigScope(snippet)) return false;
  if (snippet.kind === "config" && /package\.json|config|env|settings|docker/i.test(snippet.path)) return false;
  return /route|router|controller|handler|endpoint|api\//i.test(snippet.path)
    || /\b(GET|POST|PUT|PATCH|DELETE)\b|\b(APIRouter|FastAPI)\s*\(|\b(fetch\w*|urlopen|axios|NextRequest|NextResponse)\b|request\s*[:.]|response\s*[:.]/i.test(text);
}

function isRouteConfigScope(snippet: CodeEvidence): boolean {
  const scope = snippet.title.includes("·") ? snippet.title.split("·").at(-1)?.trim() ?? "" : "";
  return ["runtime", "dynamic", "revalidate", "preferredRegion", "maxDuration", "fetchCache"].includes(scope);
}

function isRequestHelperEvidence(snippet: CodeEvidence): boolean {
  if (snippet.kind !== "service") return false;
  const text = `${snippet.path}\n${snippet.title}\n${snippet.excerpt}`;
  if (/\bdocs?_enabled|openapi|redoc|swagger|cors|allowed_origins\b/i.test(text)) return false;
  return /\b(parse\w*|validate\w*|fetch\w*|build\w*|analyze\w*|evaluate\w*|create\w*|update\w*|delete\w*|request\.json|urlparse|urlopen|axios)\b/i.test(text);
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
  return [...new Map(snippets.map((snippet) => [evidenceIdentity(snippet), snippet])).values()];
}

function evidenceIdentity(snippet: CodeEvidence): string {
  const scope = snippet.title.includes("·")
    ? snippet.title.split("·").at(-1)?.trim() ?? ""
    : snippet.path && snippet.title.startsWith(snippet.path)
      ? snippet.title.slice(snippet.path.length).replace(/^[\s·-]+/, "").trim()
      : "";
  return `${snippet.path}:${scope || snippet.id}`;
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

function pickStructureSummaryFile(files: FileSummary[], requestFiles: string[]): FileSummary | undefined {
  for (const path of requestFiles) {
    const matched = files.find((file) => file.path === path);
    if (matched && !isContractLikePath(path)) return matched;
  }
  return pickSummaryFile(files, ["entry", "service", "ui", "config"]);
}

function isContractLikePath(path: string): boolean {
  return /(^|\/)(schemas?|models?|entities?|dto|types?)(\/|$)|(?:schema|model|entity|dto|types?)\./i.test(path);
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
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.length <= length) return normalized;

  const half = Math.floor(length / 2);
  let start = Math.max(index - half, 0);
  let end = Math.min(start + length, normalized.length);
  if (end === normalized.length) start = Math.max(normalized.length - length, 0);

  let markerOverhead = 0;
  if (start > 0) markerOverhead += OMITTED_BEFORE_MARKER.length + 2;
  if (end < normalized.length) markerOverhead += OMITTED_AFTER_MARKER.length + 2;

  const bodyLength = Math.max(120, length - markerOverhead);
  start = Math.max(index - Math.floor(bodyLength / 2), 0);
  end = Math.min(start + bodyLength, normalized.length);
  if (end === normalized.length) start = Math.max(normalized.length - bodyLength, 0);
  [start, end] = alignSliceToLines(normalized, start, end, index);

  const parts: string[] = [];
  if (start > 0) parts.push(OMITTED_BEFORE_MARKER);
  parts.push(normalized.slice(start, end).replace(/^\n+|\n+$/g, ""));
  if (end < normalized.length) parts.push(OMITTED_AFTER_MARKER);
  return parts.join("\n\n");
}

function sliceSymbolForward(content: string, index: number, length: number): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.length <= length) return normalized;

  const lineStart = normalized.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const markerOverhead = (lineStart > 0 ? OMITTED_BEFORE_MARKER.length + 2 : 0) + OMITTED_AFTER_MARKER.length + 2;
  let end = Math.min(lineStart + Math.max(120, length - markerOverhead), normalized.length);
  if (end < normalized.length) {
    const lineEnd = normalized.lastIndexOf("\n", end);
    if (lineEnd > lineStart) end = lineEnd;
  }

  const parts: string[] = [];
  if (lineStart > 0) parts.push(OMITTED_BEFORE_MARKER);
  parts.push(normalized.slice(lineStart, end).replace(/^\n+|\n+$/g, ""));
  if (end < normalized.length) parts.push(OMITTED_AFTER_MARKER);
  return parts.join("\n\n");
}

function alignSliceToLines(content: string, start: number, end: number, index: number): [number, number] {
  if (start > 0) {
    const nextNewline = content.indexOf("\n", start);
    if (nextNewline !== -1 && nextNewline < index) {
      start = nextNewline + 1;
    } else {
      start = content.lastIndexOf("\n", index - 1) + 1;
    }
  }

  if (end < content.length) {
    const previousNewline = content.lastIndexOf("\n", end);
    if (previousNewline > index) {
      end = previousNewline;
    } else {
      const nextNewline = content.indexOf("\n", index);
      end = nextNewline === -1 ? content.length : nextNewline;
    }
  }

  if (start >= end) {
    const lineStart = content.lastIndexOf("\n", index - 1) + 1;
    const lineEnd = content.indexOf("\n", index);
    return [lineStart, lineEnd === -1 ? content.length : lineEnd];
  }
  return [start, end];
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
